import { describe, expect, it } from "vitest";
import { AppError } from "./errors";
import { canBeRequired } from "./field-types";
import { assertRequiredValues, isBlankCell } from "./schemas";

const columns = [
  { name: "title", label: "Title", required: true },
  { name: "notes", label: "Notes", required: false },
];

function refusal(run: () => void): AppError | undefined {
  try {
    run();
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  return undefined;
}

describe("assertRequiredValues", () => {
  it("accepts a new row that fills every required field", () => {
    expect(() =>
      assertRequiredValues(columns, [{ title: "Pay rent" }], "insert"),
    ).not.toThrow();
  });

  it("refuses a new row that leaves one empty, naming the field", () => {
    for (const values of [{}, { title: "" }, { title: "  " }, { title: [] }]) {
      const error = refusal(() =>
        assertRequiredValues(columns, [values], "insert"),
      );
      expect(error?.code).toBe("value_required");
      expect(error?.detail).toBe("Title");
    }
  });

  it("lets a change leave a required field it does not touch", () => {
    expect(() =>
      assertRequiredValues(columns, [{ notes: "" }], "update"),
    ).not.toThrow();
  });

  it("refuses a change that empties a required field", () => {
    expect(
      refusal(() => assertRequiredValues(columns, [{ title: null }], "update"))
        ?.code,
    ).toBe("value_required");
  });

  it("asks nothing of a table without required fields", () => {
    expect(() =>
      assertRequiredValues(
        [{ name: "title", label: "Title", required: false }],
        [{}],
        "insert",
      ),
    ).not.toThrow();
  });
});

describe("isBlankCell", () => {
  it("counts zero and false as values", () => {
    expect(isBlankCell(0)).toBe(false);
    expect(isBlankCell(false)).toBe(false);
    expect(isBlankCell(["a"])).toBe(false);
    expect(isBlankCell(undefined)).toBe(true);
  });
});

describe("canBeRequired", () => {
  it("offers it to typed and chosen values only", () => {
    expect(canBeRequired("text")).toBe(true);
    expect(canBeRequired("single_select")).toBe(true);
    expect(canBeRequired("date")).toBe(true);
    expect(canBeRequired("boolean")).toBe(false);
    expect(canBeRequired("attachment")).toBe(false);
    expect(canBeRequired("formula")).toBe(false);
    expect(canBeRequired("relation_one_to_many")).toBe(false);
  });
});
