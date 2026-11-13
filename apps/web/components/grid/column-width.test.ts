import { describe, expect, it } from "vitest";
import { createLabelMeasure, defaultColumnWidth } from "./column-width";

const BY_TYPE = { date: 130, number: 120 };

describe("defaultColumnWidth", () => {
  it("keeps the type's width when the name fits", () => {
    expect(defaultColumnWidth("date", 30, BY_TYPE)).toBe(130);
    expect(defaultColumnWidth("text", 40, BY_TYPE)).toBe(180);
  });

  it("widens a column whose name would be cut", () => {
    // "Expected close" at 13 px.
    expect(defaultColumnWidth("date", 92.4, BY_TYPE)).toBe(157);
    expect(defaultColumnWidth("number", 70, BY_TYPE)).toBe(134);
  });

  it("stops widening at a ceiling: a very long name truncates", () => {
    expect(defaultColumnWidth("text", 900, BY_TYPE)).toBe(280);
  });
});

describe("createLabelMeasure", () => {
  it("measures by letters where no canvas exists", () => {
    const measure = createLabelMeasure();
    expect(measure("Probability")).toBe(82.5);
    expect(measure("")).toBe(0);
  });
});
