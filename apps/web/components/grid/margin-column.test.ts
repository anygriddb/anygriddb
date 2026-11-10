import { describe, expect, it } from "vitest";
import { marginColumn, nextFrozenColumns } from "./margin-column";

describe("marginColumn", () => {
  it("follows the last frozen column", () => {
    expect(marginColumn(1)).toBe(0);
    expect(marginColumn(3)).toBe(2);
  });

  it("falls back to the row gutter when nothing is frozen", () => {
    expect(marginColumn(0)).toBe(-1);
    expect(marginColumn(-2)).toBe(-1);
  });
});

describe("nextFrozenColumns", () => {
  it("freezes through the chosen column", () => {
    expect(nextFrozenColumns(0, 0)).toBe(1);
    expect(nextFrozenColumns(0, 2)).toBe(3);
    expect(nextFrozenColumns(1, 3)).toBe(4);
  });

  it("caps at the product freeze ceiling", () => {
    expect(nextFrozenColumns(0, 20)).toBe(10);
  });

  it("clears the freeze when the margin column is chosen again", () => {
    expect(nextFrozenColumns(2, 1)).toBe(0);
    expect(nextFrozenColumns(1, 0)).toBe(0);
    expect(nextFrozenColumns(10, 9)).toBe(0);
  });
});
