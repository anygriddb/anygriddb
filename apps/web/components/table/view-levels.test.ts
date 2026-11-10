import { describe, expect, it } from "vitest";
import { upsertFirstLevel } from "./view-levels";

describe("upsertFirstLevel", () => {
  it("inserts a new column at the front", () => {
    expect(
      upsertFirstLevel(
        [{ column: "a", direction: "asc" }],
        { column: "b", direction: "desc" },
        5,
      ),
    ).toEqual([
      { column: "b", direction: "desc" },
      { column: "a", direction: "asc" },
    ]);
  });

  it("moves an existing column to the front and updates direction", () => {
    expect(
      upsertFirstLevel(
        [
          { column: "a", direction: "asc" },
          { column: "b", direction: "asc" },
        ],
        { column: "b", direction: "desc" },
        5,
      ),
    ).toEqual([
      { column: "b", direction: "desc" },
      { column: "a", direction: "asc" },
    ]);
  });

  it("respects the max level count", () => {
    expect(
      upsertFirstLevel(
        [
          { column: "a", direction: "asc" },
          { column: "b", direction: "asc" },
          { column: "c", direction: "asc" },
        ],
        { column: "d", direction: "asc" },
        3,
      ),
    ).toEqual([
      { column: "d", direction: "asc" },
      { column: "a", direction: "asc" },
      { column: "b", direction: "asc" },
    ]);
  });
});
