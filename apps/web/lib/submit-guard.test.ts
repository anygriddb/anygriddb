import { describe, expect, it, vi } from "vitest";
import { SubmitGuard } from "./submit-guard";

function pending() {
  let finish: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return { promise, finish };
}

describe("SubmitGuard", () => {
  it("runs one send when two arrive before the first has answered", async () => {
    const guard = new SubmitGuard();
    const { promise, finish } = pending();
    const send = vi.fn(() => promise);
    const first = guard.run(send);
    const second = guard.run(send);
    expect(send).toHaveBeenCalledOnce();
    finish();
    await Promise.all([first, second]);
    expect(send).toHaveBeenCalledOnce();
  });

  it("takes a second send once the first has answered", async () => {
    const guard = new SubmitGuard();
    const send = vi.fn(() => Promise.resolve());
    await guard.run(send);
    await guard.run(send);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("takes another send after one that failed, and lets the failure through", async () => {
    const guard = new SubmitGuard();
    await expect(
      guard.run(() => Promise.reject(new Error("refused"))),
    ).rejects.toThrow("refused");
    const send = vi.fn(() => Promise.resolve());
    await guard.run(send);
    expect(send).toHaveBeenCalledOnce();
  });

  it("says when a send starts and ends", async () => {
    const seen: boolean[] = [];
    const guard = new SubmitGuard((busy) => seen.push(busy));
    await guard.run(() => Promise.resolve());
    expect(seen).toEqual([true, false]);
  });
});
