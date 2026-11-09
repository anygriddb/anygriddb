import { describe, expect, it } from "vitest";
import { marginColumn } from "./margin-column";

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
