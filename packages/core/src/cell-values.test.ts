import { describe, expect, it } from "vitest";
import { assertCellValue, coerceCellValue } from "./cell-values";

const select = {
  fieldType: "single_select" as const,
  config: {
    options: [
      { name: "Open", color: "green" as const },
      { name: "Done", color: "gray" as const },
    ],
  },
};
const multi = { ...select, fieldType: "multi_select" as const };

describe("assertCellValue", () => {
  it("accepts typed values and rejects mismatches", () => {
    expect(() =>
      assertCellValue({ fieldType: "email", config: {} }, "a@example.org"),
    ).not.toThrow();
    expect(() =>
      assertCellValue({ fieldType: "email", config: {} }, "nope"),
    ).toThrow("Invalid cell");
    expect(() =>
      assertCellValue({ fieldType: "url", config: {} }, "javascript:alert(1)"),
    ).toThrow("Invalid cell");
    expect(() => assertCellValue(multi, ["Open", "Done"])).not.toThrow();
    expect(() => assertCellValue(multi, ["Open", "Open"])).toThrow(
      "Invalid cell",
    );
    expect(() => assertCellValue(select, "Other")).toThrow("Invalid cell");
    expect(() =>
      assertCellValue({ fieldType: "rating", config: { ratingMax: 5 } }, 6),
    ).toThrow();
    expect(() =>
      assertCellValue(
        { fieldType: "datetime", config: {} },
        "2026-11-07T10:00:00Z",
      ),
    ).not.toThrow();
    expect(() =>
      assertCellValue({ fieldType: "date", config: {} }, "2026-02-30"),
    ).toThrow();
    expect(() =>
      assertCellValue({ fieldType: "formula", config: {} }, 1),
    ).toThrow("Formula column is computed");
    expect(() =>
      assertCellValue({ fieldType: "autonumber", config: {} }, 1),
    ).toThrow("Column is read-only");
    expect(() =>
      assertCellValue({ fieldType: "row_id", config: {} }, "r1"),
    ).toThrow("Column is read-only");
    expect(() =>
      assertCellValue({ fieldType: "attachment", config: {} }, ["bad"]),
    ).toThrow("Invalid attachment");
  });
});

describe("a number field that refuses negatives", () => {
  const stock = { fieldType: "number" as const, config: { nonNegative: true } };
  const free = { fieldType: "number" as const, config: {} };

  it("takes zero and above, as a decimal text or a number", () => {
    for (const value of ["0", "12.50", "-0", "-0.00", 0, 3, null]) {
      expect(() => assertCellValue(stock, value)).not.toThrow();
    }
    // Pasted text goes through the same check.
    expect(coerceCellValue(stock, "7")).toBe("7");
  });

  it("refuses a value under zero, and only where the field says so", () => {
    for (const value of ["-1", "-0.01", -3]) {
      expect(() => assertCellValue(stock, value)).toThrow(
        "Negative number refused",
      );
      expect(() => assertCellValue(free, value)).not.toThrow();
    }
    // Loose input never throws: what the field refuses does not fit.
    expect(coerceCellValue(stock, "-7")).toBeUndefined();
    expect(coerceCellValue(free, "-7")).toBe("-7");
  });
});

describe("coerceCellValue", () => {
  it("parses pasted text per type and refuses what does not fit", () => {
    expect(
      coerceCellValue({ fieldType: "number", config: {} }, "1 234,5"),
    ).toBe("1234.5");
    // Exact: a float would round these (ADR 0023).
    expect(
      coerceCellValue({ fieldType: "number", config: {} }, "9007199254740993"),
    ).toBe("9007199254740993");
    expect(coerceCellValue({ fieldType: "number", config: {} }, 0.1)).toBe(
      "0.1",
    );
    expect(
      coerceCellValue({ fieldType: "number", config: {} }, "12abc"),
    ).toBeUndefined();
    expect(coerceCellValue({ fieldType: "boolean", config: {} }, "Oui")).toBe(
      true,
    );
    expect(
      coerceCellValue({ fieldType: "date", config: {} }, "07/11/2026"),
    ).toBe("2026-11-07");
    expect(coerceCellValue({ fieldType: "duration", config: {} }, "1:30")).toBe(
      5400,
    );
    expect(coerceCellValue(select, "open")).toBe("Open");
    expect(coerceCellValue(multi, "done, open")).toEqual(["Done", "Open"]);
    expect(coerceCellValue(multi, "done, unknown")).toBeUndefined();
    expect(coerceCellValue({ fieldType: "text", config: {} }, "")).toBeNull();
    expect(
      coerceCellValue(
        { fieldType: "user", config: { multiple: true } },
        "Ada",
        {
          resolveUser: (text) =>
            text === "Ada" ? "11111111-1111-4111-8111-111111111111" : undefined,
        },
      ),
    ).toEqual(["11111111-1111-4111-8111-111111111111"]);
  });
});
