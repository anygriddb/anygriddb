import { describe, expect, it } from "vitest";
import { UndoStack, type UndoEntry } from "./undo-stack";

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
});
