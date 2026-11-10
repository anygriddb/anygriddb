import { describe, expect, it } from "vitest";
import { FIELD_TYPES, isPrimaryType, PRIMARY_TYPES } from "./field-types";

describe("PRIMARY_TYPES", () => {
  it("accepts label-friendly types", () => {
    expect(isPrimaryType("text")).toBe(true);
    expect(isPrimaryType("formula")).toBe(true);
    expect(isPrimaryType("single_select")).toBe(true);
    expect(PRIMARY_TYPES.has("autonumber")).toBe(true);
  });

  it("rejects types that cannot label a row cleanly", () => {
    expect(isPrimaryType("boolean")).toBe(false);
    expect(isPrimaryType("attachment")).toBe(false);
    expect(isPrimaryType("relation_one_to_many")).toBe(false);
    expect(isPrimaryType("button")).toBe(false);
  });

  it("only lists known field types", () => {
    const known = new Set<string>(FIELD_TYPES);
    for (const type of PRIMARY_TYPES) {
      expect(known.has(type)).toBe(true);
    }
  });
});
