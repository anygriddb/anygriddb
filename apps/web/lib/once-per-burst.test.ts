import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { oncePerBurst } from "./once-per-burst";

describe("oncePerBurst", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs once for the calls of a burst, a delay after the first", () => {
    const run = vi.fn();
    const burst = oncePerBurst(run, 2000);
    burst.soon();
    vi.advanceTimersByTime(1500);
    burst.soon();
    burst.soon();
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(run).toHaveBeenCalledTimes(1);
    // Nothing more to run: the burst is over.
    vi.advanceTimersByTime(10_000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("runs again for what comes after it ran", () => {
    const run = vi.fn();
    const burst = oncePerBurst(run, 2000);
    burst.soon();
    vi.advanceTimersByTime(2000);
    burst.soon();
    vi.advanceTimersByTime(2000);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("runs nothing once cancelled, and starts again when asked", () => {
    const run = vi.fn();
    const burst = oncePerBurst(run, 2000);
    burst.soon();
    burst.cancel();
    vi.advanceTimersByTime(5000);
    expect(run).not.toHaveBeenCalled();
    burst.soon();
    vi.advanceTimersByTime(2000);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
