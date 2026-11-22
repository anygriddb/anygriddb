import { coerceCellValue } from "@anygriddb/core";
import { describe, expect, it } from "vitest";
import { editableNumber, readingGiven, readingIn } from "./cell-reading";

const number = { fieldType: "number" as const, config: {} };
const day = { fieldType: "date" as const, config: {} };

describe("what the screens read a value with", () => {
  it("fixes the decimal mark by language, and the day's place in French only", () => {
    expect(readingIn("fr")).toMatchObject({
      decimalMark: ",",
      dayOrder: "day-first",
    });
    expect(readingIn("en")).toMatchObject({ decimalMark: "." });
    expect(readingIn("en").dayOrder).toBeUndefined();
  });

  it("reads what a link gave with a decimal point, whatever the language", () => {
    expect(coerceCellValue(number, "1.234", readingIn("fr"))).toBeUndefined();
    expect(coerceCellValue(number, "1.234", readingGiven())).toBe("1.234");
    expect(coerceCellValue(day, "03/04/2026", readingGiven())).toBeUndefined();
  });

  it("opens a stored number so that it reads back the same", () => {
    const shown = editableNumber("1.234", "fr");
    expect(shown).toBe("1,234");
    expect(coerceCellValue(number, shown, readingIn("fr"))).toBe("1.234");
    expect(editableNumber("1.234", "en")).toBe("1.234");
  });
});
