import { describe, expect, it } from "vitest";
import { inTurn, MAX_WAITING_GUESSES } from "./guess-turns.js";

/** A promise and the function that settles it. */
function gate(): { opened: Promise<void>; open: () => void } {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

describe("inTurn", () => {
  it("runs the guesses about one subject one after the other", async () => {
    const order: string[] = [];
    const first = gate();
    const one = inTurn("a", async () => {
      order.push("one starts");
      await first.opened;
      order.push("one ends");
    });
    const two = inTurn("a", async () => {
      order.push("two starts");
    });
    await Promise.resolve();
    expect(order).toEqual(["one starts"]);
    first.open();
    await Promise.all([one, two]);
    expect(order).toEqual(["one starts", "one ends", "two starts"]);
  });

  it("lets another subject through meanwhile", async () => {
    const held = gate();
    const slow = inTurn("a", () => held.opened);
    await expect(inTurn("b", async () => "b")).resolves.toBe("b");
    held.open();
    await slow;
  });

  it("gives the turn on after a guess that throws", async () => {
    await expect(
      inTurn("a", async () => {
        throw new Error("wrong");
      }),
    ).rejects.toThrow("wrong");
    await expect(inTurn("a", async () => "next")).resolves.toBe("next");
  });

  it("refuses a guess once enough are waiting, and takes one again after", async () => {
    const held = gate();
    const running = inTurn("a", () => held.opened);
    const waiting = Array.from({ length: MAX_WAITING_GUESSES }, () =>
      inTurn("a", async () => "waited"),
    );
    await expect(inTurn("a", async () => "late")).rejects.toMatchObject({
      code: "too_many_attempts",
    });
    held.open();
    await running;
    await expect(Promise.all(waiting)).resolves.toEqual(
      waiting.map(() => "waited"),
    );
    await expect(inTurn("a", async () => "after")).resolves.toBe("after");
  });
});
