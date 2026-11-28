import { describe, expect, it } from "vitest";
import {
  filterAttributes,
  filterGap,
  filterGroupSchema,
  resolveAttributes,
  type FilterGroup,
} from "./filter";

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

describe("a rule naming the reader's attribute (ADR 0142)", () => {
  const rule: FilterGroup = {
    conjunction: "and",
    conditions: [
      { column: "ward", op: "is", value: { attribute: "ward" } },
      {
        conjunction: "or",
        conditions: [
          { column: "teams", op: "has_any_of", value: { attribute: "team" } },
          { column: "site", op: "is", value: { attribute: "site" } },
        ],
      },
      { column: "status", op: "is", value: "open" },
    ],
  };

  it("takes an attribute's key, and refuses one that is no key", () => {
    expect(filterGroupSchema.safeParse(rule).success).toBe(true);
    for (const attribute of ["Ward", "1ward", "ward-name", ""]) {
      expect(
        filterGroupSchema.safeParse({
          conjunction: "and",
          conditions: [{ column: "ward", op: "is", value: { attribute } }],
        }).success,
      ).toBe(false);
    }
  });

  it("lists the attributes it names, each once", () => {
    expect(filterAttributes(rule).sort()).toEqual(["site", "team", "ward"]);
  });

  it("reads as the reader's values, and leaves one they hold none of as written", () => {
    const held: Record<string, string[]> = {
      ward: ["3", "4"],
      team: ["night"],
      site: [],
    };
    expect(resolveAttributes(rule, (key) => held[key])).toEqual({
      conjunction: "and",
      conditions: [
        { column: "ward", op: "is_any_of", value: ["3", "4"] },
        {
          conjunction: "or",
          conditions: [
            { column: "teams", op: "has_any_of", value: ["night"] },
            { column: "site", op: "is", value: { attribute: "site" } },
          ],
        },
        { column: "status", op: "is", value: "open" },
      ],
    });
  });
});
