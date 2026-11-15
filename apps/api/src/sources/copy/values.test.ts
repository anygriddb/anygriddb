import { describe, expect, it } from "vitest";
import { contentId, FieldSample, isCopyableName, rowId } from "./values.js";

describe("a row's id in a store that speaks no SQL", () => {
  it("is the key itself, or a JSON array of several", () => {
    expect(rowId(["573a1390f29313caabcd4135"])).toBe(
      "573a1390f29313caabcd4135",
    );
    expect(rowId([42])).toBe("42");
    expect(rowId(["eu", 7])).toBe('["eu",7]');
  });

  it("is a digest when the key cannot be an id", () => {
    const empty = rowId([""]);
    const long = rowId(["x".repeat(501)]);
    expect(empty).toMatch(/^~[0-9a-f]{64}$/);
    expect(long).toMatch(/^~[0-9a-f]{64}$/);
    expect(long).not.toBe(empty);
    // The same key is the same row at every refresh.
    expect(rowId(["x".repeat(501)])).toBe(long);
  });

  it("is the row's content when it has no key, whatever the order", () => {
    const one = contentId({ name: "Ada", age: 36 });
    expect(one).toMatch(/^~[0-9a-f]{64}$/);
    expect(contentId({ age: 36, name: "Ada" })).toBe(one);
    expect(contentId({ name: "Ada", age: 37 })).not.toBe(one);
  });
});

describe("a field a copy can keep", () => {
  it("takes the names a PostgreSQL column takes", () => {
    expect(isCopyableName("customer")).toBe(true);
    expect(isCopyableName("Montant TTC (€)")).toBe(true);
    expect(isCopyableName("a.b")).toBe(true);
  });

  it("refuses the others", () => {
    expect(isCopyableName("")).toBe(false);
    expect(isCopyableName("ag_id")).toBe(false);
    expect(isCopyableName("x".repeat(64))).toBe(false);
    // 63 characters, more bytes.
    expect(isCopyableName("é".repeat(40))).toBe(false);
    expect(isCopyableName("a\u0000b")).toBe(false);
  });
});

describe("a field's type, told from its values", () => {
  const sample = (
    values: ReadonlyArray<Parameters<FieldSample["add"]>>,
  ): { type: string; fieldType: string } => {
    const field = new FieldSample();
    for (const value of values) field.add(...value);
    const described = field.describe();
    return { type: described.type, fieldType: described.field.fieldType };
  };

  it("is the kind every value has", () => {
    expect(sample([["text", "string", "Ada"]])).toEqual({
      type: "string",
      fieldType: "text",
    });
    expect(sample([["text", "string", "one\ntwo"]])).toEqual({
      type: "string",
      fieldType: "long_text",
    });
    expect(sample([["text", "string", "x".repeat(256)]]).fieldType).toBe(
      "long_text",
    );
    expect(
      sample([
        ["integer", "int"],
        ["integer", "int"],
      ]),
    ).toEqual({ type: "int", fieldType: "number" });
    expect(sample([["boolean", "bool"]]).fieldType).toBe("boolean");
    expect(sample([["datetime", "date"]]).fieldType).toBe("datetime");
    expect(sample([["document", "array"]]).fieldType).toBe("json");
  });

  it("keeps numbers of two kinds as numbers, under the type that holds both", () => {
    expect(
      sample([
        ["integer", "int"],
        ["integer", "bigint"],
      ]),
    ).toEqual({ type: "bigint", fieldType: "number" });
    expect(
      sample([
        ["integer", "int"],
        ["number", "double"],
      ]),
    ).toEqual({ type: "double", fieldType: "number" });
  });

  it("reads anything else mixed as text, and an empty field too", () => {
    expect(
      sample([
        ["integer", "int"],
        ["text", "string", "n/a"],
      ]),
    ).toEqual({ type: "mixed", fieldType: "text" });
    expect(
      sample([
        ["text", "string", "x"],
        ["document", "object"],
      ]),
    ).toEqual({ type: "mixed", fieldType: "long_text" });
    expect(
      sample([
        ["text", "string", "x"],
        ["text", "objectId", "573a1390f29313caabcd4135"],
      ]),
    ).toEqual({ type: "mixed", fieldType: "text" });
    expect(sample([])).toEqual({ type: "null", fieldType: "text" });
  });
});
