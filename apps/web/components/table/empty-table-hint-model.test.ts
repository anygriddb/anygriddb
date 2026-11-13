import { describe, expect, it } from "vitest";
import { emptyTableHint } from "./empty-table-hint-model";

const EMPTY = {
  total: 0,
  loading: false,
  grouped: false,
  searched: false,
  filtered: false,
  canAdd: true,
  canImport: true,
};

describe("emptyTableHint", () => {
  it("says how to start a table with no row", () => {
    expect(emptyTableHint(EMPTY)).toBe("start");
    expect(emptyTableHint({ ...EMPTY, canAdd: false })).toBe("start");
  });

  it("says nothing matches when filters or a search empty the view", () => {
    expect(emptyTableHint({ ...EMPTY, filtered: true })).toBe(
      "nothing-matches",
    );
    expect(emptyTableHint({ ...EMPTY, searched: true, canAdd: false })).toBe(
      "nothing-matches",
    );
  });

  it("stays quiet while reading, with rows, or for a reader", () => {
    expect(emptyTableHint({ ...EMPTY, loading: true })).toBeNull();
    expect(emptyTableHint({ ...EMPTY, total: 3 })).toBeNull();
    expect(emptyTableHint({ ...EMPTY, grouped: true })).toBeNull();
    expect(
      emptyTableHint({ ...EMPTY, canAdd: false, canImport: false }),
    ).toBeNull();
  });
});
