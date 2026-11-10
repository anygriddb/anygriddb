import type { FilterGroup } from "@anygriddb/core";
import { describe, expect, it } from "vitest";
import {
  chipValueText,
  filterChips,
  withoutChip,
  type ChipWords,
} from "./filter-chips";

const words: ChipWords = {
  me: "me",
  checked: "checked",
  unchecked: "unchecked",
  period: (mode) => (mode === "days_ago" ? "N days ago" : mode),
  person: (id) => (id === "u1" ? "Ada" : undefined),
};

const filter: FilterGroup = {
  conjunction: "or",
  conditions: [
    { column: "status", op: "is", value: "Done" },
    {
      conjunction: "and",
      conditions: [
        { column: "owner", op: "is_any_of", value: ["u1", "me"] },
        { column: "due", op: "is_before", value: { mode: "today" } },
      ],
    },
  ],
};

describe("filterChips", () => {
  it("keeps a nested group whole and says how the chips join", () => {
    const { conjunction, chips } = filterChips(filter);
    expect(conjunction).toBe("or");
    expect(chips.map((chip) => chip.kind)).toEqual(["condition", "group"]);
    expect(chips[1]).toMatchObject({ kind: "group", count: 2 });
  });

  it("removes a top-level chip, the group with all it holds", () => {
    expect(withoutChip(filter, 1)).toEqual({
      conjunction: "or",
      conditions: [{ column: "status", op: "is", value: "Done" }],
    });
    expect(withoutChip(withoutChip(filter, 1), 0)).toBeNull();
    expect(filterChips(undefined).chips).toEqual([]);
  });
});

describe("chipValueText", () => {
  it("names people and periods instead of ids and modes", () => {
    expect(chipValueText(["u1", "me", "u9"], words)).toBe("Ada, me, u9");
    expect(chipValueText({ mode: "days_ago", days: 3 }, words)).toBe(
      "3 days ago",
    );
    expect(chipValueText({ mode: "exact", date: "2026-11-10" }, words)).toBe(
      "2026-11-10",
    );
    expect(chipValueText(true, words)).toBe("checked");
  });

  it("says nothing for an empty value", () => {
    expect(chipValueText(null, words)).toBe("");
    expect(chipValueText("", words)).toBe("");
    expect(chipValueText(undefined, words)).toBe("");
  });
});
