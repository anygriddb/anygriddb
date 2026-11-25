import { describe, expect, it } from "vitest";
import {
  FIELD_DEFINITIONS,
  FIELD_TYPES,
  PRIMARY_TYPES,
  SYSTEM_COLUMN,
  WRITABLE_TYPES,
  canBeRequired,
  comparedAs,
  hasPhysicalColumn,
  isComputedType,
  isPrimaryType,
  isRelationType,
  isSystemType,
  isWritableType,
  physicalSqlType,
  storedValueKind,
  type FieldType,
} from "./field-types";
import { SIDE_FIELD_TYPES } from "./query/external-write";

describe("FIELD_DEFINITIONS", () => {
  it("names every FieldType exactly once", () => {
    expect(Object.keys(FIELD_DEFINITIONS).sort()).toEqual(
      [...FIELD_TYPES].sort(),
    );
  });

  it("keeps predicates aligned with the definitions", () => {
    for (const type of FIELD_TYPES) {
      const def = FIELD_DEFINITIONS[type];
      expect(isWritableType(type), type).toBe(def.physical.role === "writable");
      expect(isSystemType(type), type).toBe(def.physical.role === "system");
      expect(isComputedType(type), type).toBe(def.physical.role === "computed");
      expect(isRelationType(type), type).toBe(
        def.physical.role === "relation_fk" ||
          def.physical.role === "relation_virtual",
      );
      expect(isPrimaryType(type), type).toBe(def.primaryEligible);
      expect(canBeRequired(type), type).toBe(def.requiredAllowed);
      expect(hasPhysicalColumn(type), type).toBe(
        def.physical.role === "writable" || def.physical.role === "relation_fk",
      );
    }
  });

  it("keeps WRITABLE_TYPES and PRIMARY_TYPES as the definitions say", () => {
    expect([...WRITABLE_TYPES].sort()).toEqual(
      FIELD_TYPES.filter((type) => isWritableType(type)).sort(),
    );
    expect([...PRIMARY_TYPES].sort()).toEqual(
      FIELD_TYPES.filter((type) => isPrimaryType(type)).sort(),
    );
  });

  it("keeps system column names and physical SQL types as before", () => {
    for (const [type, column] of Object.entries(SYSTEM_COLUMN)) {
      const physical = FIELD_DEFINITIONS[type as FieldType].physical;
      expect(physical.role, type).toBe("system");
      expect(
        physical.role === "system" ? physical.column : undefined,
        type,
      ).toBe(column);
    }
    expect(physicalSqlType("text")).toBe("text");
    expect(physicalSqlType("json")).toBe("jsonb");
    expect(physicalSqlType("multi_select")).toBe("text[]");
    expect(physicalSqlType("relation_one_to_many")).toBe("uuid");
    expect(() => physicalSqlType("formula")).toThrow();
  });

  it("keeps stored value kinds for every non-computed type", () => {
    const kinds: Record<
      Exclude<FieldType, "formula" | "lookup" | "rollup">,
      string
    > = {
      text: "text",
      long_text: "text",
      email: "text",
      url: "text",
      phone: "text",
      color: "text",
      place: "text",
      json: "text",
      single_select: "text",
      number: "number",
      rating: "number",
      duration: "number",
      boolean: "boolean",
      date: "date",
      datetime: "datetime",
      multi_select: "options",
      user: "users",
      attachment: "files",
      relation_one_to_many: "links",
      relation_many_to_many: "links",
      created_time: "datetime",
      last_modified_time: "datetime",
      created_by: "user",
      last_modified_by: "user",
      autonumber: "number",
      row_id: "text",
      button: "text",
    };
    for (const [type, kind] of Object.entries(kinds) as Array<
      [keyof typeof kinds, string]
    >) {
      expect(storedValueKind(type), type).toBe(kind);
    }
  });

  it("keeps side-eligible types aligned with SIDE_FIELD_TYPES", () => {
    expect(
      FIELD_TYPES.filter((type) => FIELD_DEFINITIONS[type].sideEligible).sort(),
    ).toEqual([...SIDE_FIELD_TYPES].sort());
  });

  it("compares as seen by the kind of value each type keeps", () => {
    const byWay = (way: string) =>
      FIELD_TYPES.filter((type) => comparedAs(type) === way).sort();
    expect(byWay("text")).toEqual(
      [
        "color",
        "email",
        "long_text",
        "phone",
        "place",
        "single_select",
        "text",
        "url",
      ].sort(),
    );
    expect(byWay("document")).toEqual(["json"]);
    expect(byWay("instant")).toEqual(["date", "datetime"]);
    expect(byWay("checkbox")).toEqual(["boolean"]);
    expect(byWay("files")).toEqual(["attachment"]);
    // A type nobody defined, or none, is compared as the value it is.
    expect(comparedAs("nonsense")).toBe("value");
    expect(comparedAs(undefined)).toBe("value");
  });
});
