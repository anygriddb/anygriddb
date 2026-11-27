import { describe, expect, it } from "vitest";
import { filterGap } from "./filter";

const own = {
  conjunction: "and" as const,
  conditions: [{ column: "seller", op: "is" as const, value: "ada" }],
};

describe("filterGap", () => {
  it("lets a filter whose every condition has its value be saved", () => {
    expect(filterGap(own)).toBeNull();
    expect(
      filterGap({
        conjunction: "or",
        conditions: [
          own,
          { column: "region", op: "is_empty" },
          { column: "paid", op: "is", value: false },
          { column: "amount", op: "is_between", value: ["10", ""] },
        ],
      }),
    ).toBeNull();
  });

  it("refuses a filter or a group without a condition", () => {
    expect(filterGap({ conjunction: "and", conditions: [] })).toEqual({
      kind: "empty",
    });
    expect(
      filterGap({
        conjunction: "and",
        conditions: [own, { conjunction: "or", conditions: [] }],
      }),
    ).toEqual({ kind: "empty" });
  });

  it("names the first condition still waiting for its value", () => {
    for (const value of [
      undefined,
      null,
      "",
      [],
      ["", ""],
      { mode: "exact" as const },
    ]) {
      expect(
        filterGap({
          conjunction: "and",
          conditions: [own, { column: "region", op: "is", value }],
        }),
      ).toEqual({ kind: "blank", column: "region" });
    }
  });
});
