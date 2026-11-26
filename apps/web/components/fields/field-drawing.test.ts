import { FIELD_TYPES } from "@anygriddb/core";
import { describe, expect, it } from "vitest";
import { drawingOf } from "./field-drawing";

const link = [{ id: "r1", label: "Acme" }];

describe("how a cell is drawn", () => {
  it("draws each type its own way when its value is one it can", () => {
    const drawn = (fieldType: string, value: unknown, kind?: string) =>
      drawingOf({ fieldType, ...(kind ? { kind } : {}) }, value);
    expect(drawn("boolean", true)).toBe("checkbox");
    expect(drawn("multi_select", ["Open"])).toBe("options");
    expect(drawn("rating", 3)).toBe("stars");
    expect(drawn("created_by", "u1")).toBe("people");
    expect(drawn("attachment", [])).toBe("files");
    expect(drawn("relation_many_to_many", link)).toBe("links");
    expect(drawn("url", "https://example.org")).toBe("address");
    expect(drawn("email", "a@example.org")).toBe("mail");
    expect(drawn("color", "#1f3fae")).toBe("swatch");
    expect(drawn("place", "48.8566, 2.3522")).toBe("place");
    expect(drawn("json", '{"a":1}')).toBe("document");
    expect(drawn("row_id", "r1")).toBe("id");
    expect(drawn("row_state", "submitted")).toBe("state");
    expect(drawn("number", "42")).toBe("text");
  });

  it("draws a computed value as what it holds, and anything else as text", () => {
    // A formula that answers yes or no is ticked; a lookup of links links.
    expect(drawingOf({ fieldType: "formula", kind: "boolean" }, true)).toBe(
      "checkbox",
    );
    expect(drawingOf({ fieldType: "lookup", kind: "links" }, link)).toBe(
      "links",
    );
    // A rating that holds no number, an address that is no text: as text.
    expect(drawingOf({ fieldType: "rating" }, "3")).toBe("text");
    expect(drawingOf({ fieldType: "url" }, 42)).toBe("text");
    expect(drawingOf({ fieldType: "nonsense" }, "x")).toBe("text");
  });

  it("knows every type", () => {
    for (const type of FIELD_TYPES) {
      expect(typeof drawingOf({ fieldType: type }, "x"), type).toBe("string");
    }
  });
});
