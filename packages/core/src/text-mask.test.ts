import { describe, expect, it } from "vitest";
import { fitsMask, isMask, MAX_MASK_LENGTH, maskPattern } from "./text-mask";

describe("a text field's mask", () => {
  it("takes digits, letters, either, and characters as themselves", () => {
    expect(fitsMask("AA-####", "fr-0012")).toBe(true);
    expect(fitsMask("AA-####", "FR-0012")).toBe(true);
    expect(fitsMask("***", "a1B")).toBe(true);
    expect(fitsMask("\\#-##", "#-42")).toBe(true);
    expect(fitsMask("Ward #", "Ward 3")).toBe(true);
  });

  it("refuses a value too short, too long, or with a character out of place", () => {
    expect(fitsMask("AA-####", "FR-012")).toBe(false);
    expect(fitsMask("AA-####", "FR-00123")).toBe(false);
    expect(fitsMask("AA-####", "F1-0012")).toBe(false);
    expect(fitsMask("AA-####", "FR_0012")).toBe(false);
    // A letter is one from A to Z: an accented one or a digit in another
    // script is not.
    expect(fitsMask("A", "é")).toBe(false);
    expect(fitsMask("#", "٣")).toBe(false);
    expect(fitsMask("Ward #", "ward 3")).toBe(false);
  });

  it("counts a character beyond the basic plane as one", () => {
    expect(fitsMask("*-🙂", "a-🙂")).toBe(true);
    expect(fitsMask("##", "🙂")).toBe(false);
  });

  it("keeps a mask of one slot at least, with nothing left dangling", () => {
    expect(isMask("AA-####")).toBe(true);
    expect(isMask("\\\\")).toBe(true);
    for (const mask of ["", "AA\\", "A".repeat(MAX_MASK_LENGTH + 1), "A\nB"]) {
      expect(isMask(mask)).toBe(false);
    }
  });

  it("writes itself as an anchored expression whose literals stay literal", () => {
    expect(maskPattern("AA-##.*")).toBe(
      "^[A-Za-z][A-Za-z]\\-[0-9][0-9]\\.[0-9A-Za-z]$",
    );
    const pattern = new RegExp(maskPattern("(#)"));
    expect(pattern.test("(4)")).toBe(true);
    expect(pattern.test("44")).toBe(false);
  });
});
