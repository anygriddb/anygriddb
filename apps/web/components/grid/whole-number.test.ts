import { describe, expect, it } from "vitest";
import { wholeNumberIn } from "./whole-number";

describe("wholeNumberIn", () => {
  it("reads a whole number within the bounds, the bounds included", () => {
    expect(wholeNumberIn("60", 60, 1200)).toBe(60);
    expect(wholeNumberIn(" 240 ", 60, 1200)).toBe(240);
    expect(wholeNumberIn("1200", 60, 1200)).toBe(1200);
  });

  it.each([
    "59",
    "1201",
    "",
    " ",
    "1e3",
    "0x10",
    "12.5",
    "-100",
    "99999999999999999999",
  ])("refuses %j", (text) => {
    expect(wholeNumberIn(text, 60, 1200)).toBeNull();
  });
});
