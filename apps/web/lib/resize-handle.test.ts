import { describe, expect, it } from "vitest";
import { clampWidth, widthForKey } from "./resize-handle";

const bounds = { min: 180, max: 480, reset: 240 };

describe("widthForKey", () => {
  it("moves by a step, four with Shift, to the ends, and back to the reset", () => {
    expect(widthForKey(240, "ArrowRight", bounds)).toBe(256);
    expect(widthForKey(240, "ArrowLeft", bounds, true)).toBe(180);
    expect(widthForKey(300, "Home", bounds)).toBe(180);
    expect(widthForKey(300, "End", bounds)).toBe(480);
    expect(widthForKey(300, "Enter", bounds)).toBe(240);
  });

  it("stays within its bounds and leaves other keys alone", () => {
    expect(widthForKey(475, "ArrowRight", bounds)).toBe(480);
    expect(widthForKey(240, "a", bounds)).toBeNull();
    expect(widthForKey(240, "Enter", { min: 60, max: 1200 })).toBeNull();
    expect(clampWidth(300.6, bounds)).toBe(301);
  });
});
