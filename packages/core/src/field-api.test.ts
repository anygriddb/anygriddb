import { describe, expect, it } from "vitest";
import { assertCellValue } from "./cell-values";
import {
  apiValueExample,
  apiValueNote,
  apiValueSchema,
  takesApiWrites,
} from "./field-api";
import { FIELD_TYPES, isWritableType } from "./field-types";

const OPTIONS = ["Open", "Done"];

/** Ids a reader fills in: the guide names them, it cannot make one up. */
const PLACEHOLDER = /^<.+>$/;

describe("the API's description of a field's value", () => {
  it("shows, for every field a client writes, a value the cell check keeps", () => {
    for (const fieldType of FIELD_TYPES.filter(takesApiWrites)) {
      const example = apiValueExample(
        { fieldType, kind: "text", options: OPTIONS },
        "Some text",
      );
      expect(example, fieldType).not.toBeUndefined();
      const placeholder =
        Array.isArray(example) &&
        example.every((item) => PLACEHOLDER.test(String(item)));
      if (!isWritableType(fieldType) || placeholder) continue;
      expect(
        () =>
          assertCellValue(
            {
              fieldType,
              config: {
                options: OPTIONS.map((name) => ({ name, color: "gray" })),
              },
            },
            example,
          ),
        fieldType,
      ).not.toThrow();
    }
  });

  it("shows nothing to write for a field nobody writes", () => {
    for (const fieldType of FIELD_TYPES.filter(
      (type) => !takesApiWrites(type),
    )) {
      expect(
        apiValueExample({ fieldType, kind: "text" }, "Some text"),
        fieldType,
      ).toBeUndefined();
    }
  });

  it("gives an exact number as decimal text, its example matching its schema", () => {
    const field = { fieldType: "number", kind: "number" } as const;
    const schema = apiValueSchema(field);
    const example = apiValueExample(field, "Some text");
    expect(schema).toMatchObject({ type: "string", format: "decimal" });
    expect(typeof example).toBe("string");
    expect(String(example)).toMatch(new RegExp(String(schema.pattern)));
    expect(apiValueNote("number")).toMatch(/as a string/);
    expect(apiValueNote("text")).toBeUndefined();
  });

  it("types a computed field by what it reads as", () => {
    expect(apiValueSchema({ fieldType: "formula", kind: "number" })).toEqual(
      apiValueSchema({ fieldType: "number", kind: "number" }),
    );
    expect(apiValueSchema({ fieldType: "rollup", kind: "boolean" })).toEqual({
      type: "boolean",
    });
    expect(apiValueSchema({ fieldType: "lookup", kind: "array" })).toEqual({
      type: "array",
      items: {},
    });
  });

  it("offers a list's options, and its first when none is chosen", () => {
    expect(
      apiValueSchema({
        fieldType: "single_select",
        kind: "text",
        options: OPTIONS,
      }),
    ).toEqual({ type: "string", enum: OPTIONS });
    expect(
      apiValueExample({ fieldType: "single_select", kind: "text" }, "x"),
    ).toBe("Option");
    expect(
      apiValueExample(
        { fieldType: "multi_select", kind: "options", options: OPTIONS },
        "x",
      ),
    ).toEqual(OPTIONS);
  });
});
