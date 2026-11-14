import { describe, expect, it } from "vitest";
import {
  importWorkbookInputSchema,
  importWorkbookJobInputSchema,
  MAX_WORKBOOK_SHEETS,
} from "./workbook";

const importId = "0b5c4f3e-8a5e-4c43-9f61-2d4b8d1c7a10";

describe("a workbook made a base", () => {
  it("takes the sheets chosen by their place, and a name", () => {
    expect(
      importWorkbookInputSchema.parse({ importId, sheets: [0, 2] }),
    ).toEqual({ importId, sheets: [0, 2] });
    expect(
      importWorkbookJobInputSchema.parse({
        importId,
        name: "Budget",
        sheets: [1],
      }).name,
    ).toBe("Budget");
  });

  it("refuses no sheet, a sheet twice, too many, and a job without its name", () => {
    for (const sheets of [
      [],
      [1, 1],
      [-1],
      Array.from({ length: MAX_WORKBOOK_SHEETS + 1 }, (_, index) => index),
    ]) {
      expect(
        importWorkbookInputSchema.safeParse({ importId, sheets }).success,
      ).toBe(false);
    }
    expect(
      importWorkbookJobInputSchema.safeParse({ importId, sheets: [0] }).success,
    ).toBe(false);
  });
});
