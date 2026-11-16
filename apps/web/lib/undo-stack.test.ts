import { describe, expect, it } from "vitest";
import { StepGivenUp, UndoStack, type UndoEntry } from "./undo-stack";

/** An entry that writes what it does into `log`. */
function entry(
  log: string[],
  name: string,
  settled?: Promise<boolean>,
): UndoEntry {
  return {
    label: name,
    undo: () => {
      log.push(`undo ${name}`);
      return Promise.resolve();
    },
    redo: () => {
      log.push(`redo ${name}`);
      return Promise.resolve();
    },
    ...(settled ? { settled } : {}),
  };
}

describe("UndoStack", () => {
  it("undoes an edit still being saved once it is, and redoes it in order", async () => {
    const log: string[] = [];
    const stack = new UndoStack(() => undefined);
    stack.push(entry(log, "a"));
    let save: (applied: boolean) => void = () => undefined;
    stack.push(
      entry(
        log,
        "b",
        new Promise<boolean>((resolve) => {
          save = resolve;
        }),
      ),
    );
    // Ctrl Z, then Ctrl Y, before the edit is saved.
    const undone = stack.undo();
    const redone = stack.redo();
    await Promise.resolve();
    expect(log).toEqual([]);
    save(true);
    await expect(undone).resolves.toMatchObject({ label: "b" });
    await expect(redone).resolves.toMatchObject({ label: "b" });
    expect(log).toEqual(["undo b", "redo b"]);
  });

  it("passes over an edit whose save failed, and has nothing past the first", async () => {
    const log: string[] = [];
    const sizes: number[] = [];
    const stack = new UndoStack((next) => sizes.push(next.past));
    stack.push(entry(log, "a"));
    stack.push(entry(log, "failed", Promise.resolve(false)));
    await expect(stack.undo()).resolves.toMatchObject({ label: "a" });
    await expect(stack.undo()).resolves.toBeUndefined();
    expect(log).toEqual(["undo a"]);
    expect(sizes.at(-1)).toBe(0);
  });

  it("drops a step whose undo failed, so the one before still undoes", async () => {
    const log: string[] = [];
    const stack = new UndoStack(() => undefined);
    stack.push({
      label: "a",
      undo: () => {
        log.push("undo a");
        return Promise.resolve();
      },
      redo: () => Promise.resolve(),
    });
    stack.push({
      label: "b",
      undo: () => Promise.reject(new Error("row locked")),
      redo: () => Promise.resolve(),
    });
    await expect(stack.undo()).rejects.toThrow("row locked");
    await expect(stack.undo()).resolves.toMatchObject({ label: "a" });
    expect(log).toEqual(["undo a"]);
  });

  it("keeps a step whose undo or redo failed, when asked to", async () => {
    const log: string[] = [];
    let failUndo = true;
    let failRedo = true;
    const stack = new UndoStack(() => undefined, { keepFailed: true });
    stack.push({
      label: "a",
      undo: () => {
        if (failUndo) return Promise.reject(new Error("undo failed"));
        log.push("undo");
        return Promise.resolve();
      },
      redo: () => {
        if (failRedo) return Promise.reject(new Error("redo failed"));
        log.push("redo");
        return Promise.resolve();
      },
    });
    await expect(stack.undo()).rejects.toThrow("undo failed");
    expect(log).toEqual([]);
    failUndo = false;
    await expect(stack.undo()).resolves.toMatchObject({ label: "a" });
    await expect(stack.redo()).rejects.toThrow("redo failed");
    expect(log).toEqual(["undo"]);
    failRedo = false;
    await expect(stack.redo()).resolves.toMatchObject({ label: "a" });
    expect(log).toEqual(["undo", "redo"]);
  });

  it("keeps a step the person gave up, and reports nothing", async () => {
    const log: string[] = [];
    const sizes: Array<{ past: number; future: number }> = [];
    let answered = false;
    const stack = new UndoStack((next) => sizes.push(next));
    // A step that asks why before it writes: unanswered, it does nothing.
    const asks = () => {
      if (!answered) return Promise.reject(new StepGivenUp());
      log.push("done");
      return Promise.resolve();
    };
    stack.push({ label: "a", undo: asks, redo: asks });
    await expect(stack.undo()).resolves.toBeUndefined();
    expect(sizes.at(-1)).toEqual({ past: 1, future: 0 });
    answered = true;
    await expect(stack.undo()).resolves.toMatchObject({ label: "a" });
    answered = false;
    await expect(stack.redo()).resolves.toBeUndefined();
    expect(sizes.at(-1)).toEqual({ past: 0, future: 1 });
    expect(log).toEqual(["done"]);
  });
});
