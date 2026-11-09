import { describe, expect, it } from "vitest";
import { nextRetryDelay, rowEventSchema, touchesWatched } from "./events";

describe("rowEventSchema", () => {
  it("accepts a row change", () => {
    expect(
      rowEventSchema.safeParse({
        tableId: "11111111-1111-4111-8111-111111111111",
        event: "update",
        rowId: "22222222-2222-4222-8222-222222222222",
        columns: ["statut"],
        depth: 1,
      }).success,
    ).toBe(true);
  });

  it("refuses unknown events and runaway depth", () => {
    const base = { tableId: "11111111-1111-4111-8111-111111111111" };
    expect(rowEventSchema.safeParse({ ...base, event: "drop" }).success).toBe(
      false,
    );
    expect(
      rowEventSchema.safeParse({ ...base, event: "insert", depth: 9 }).success,
    ).toBe(false);
  });
});

describe("nextRetryDelay", () => {
  it("backs off, then gives up", () => {
    expect([1, 2, 3, 4].map(nextRetryDelay)).toEqual([60, 300, 1_800, null]);
  });
});

describe("touchesWatched", () => {
  it("matches when nothing is watched or the change is unknown", () => {
    expect(touchesWatched([], ["a"])).toBe(true);
    expect(touchesWatched(["a"], undefined)).toBe(true);
  });

  it("matches only watched columns", () => {
    expect(touchesWatched(["a", "b"], ["b"])).toBe(true);
    expect(touchesWatched(["a"], ["c"])).toBe(false);
  });
});
