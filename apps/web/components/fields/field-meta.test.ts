import { FIELD_TYPES } from "@anygriddb/core";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_WIDTH,
  FIELD_DESCRIPTIONS,
  FIELD_GROUPS,
  FIELD_LABELS,
  isComputedField,
  isLinkField,
} from "./field-meta";

describe("what a screen shows of each field type", () => {
  it("names every type, and says what each one the picker offers holds", () => {
    for (const type of FIELD_TYPES) {
      expect(FIELD_LABELS[type], type).toBeDefined();
    }
    for (const type of FIELD_GROUPS.flatMap((group) => group.types)) {
      expect(FIELD_DESCRIPTIONS[type], type).toBeDefined();
    }
    // A type no definition holds has no name of its own.
    expect(FIELD_LABELS.nonsense).toBeUndefined();
  });

  it("starts the columns that need it at their own width", () => {
    expect(DEFAULT_WIDTH).toEqual({
      long_text: 260,
      number: 120,
      boolean: 90,
      date: 130,
      datetime: 170,
      json: 260,
      rating: 130,
      duration: 110,
      autonumber: 90,
      row_id: 290,
    });
  });

  it("takes computed and link fields from the types' definitions", () => {
    expect(FIELD_TYPES.filter(isComputedField).sort()).toEqual(
      [
        "autonumber",
        "button",
        "created_by",
        "created_time",
        "formula",
        "last_modified_by",
        "last_modified_time",
        "lookup",
        "rollup",
        "row_id",
        "row_state",
      ].sort(),
    );
    expect(FIELD_TYPES.filter(isLinkField).sort()).toEqual([
      "relation_many_to_many",
      "relation_one_to_many",
    ]);
    expect(isComputedField("nonsense")).toBe(false);
    expect(isLinkField("link")).toBe(false);
  });
});
