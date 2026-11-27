import { BASE_TEMPLATES, OUTBOUND_FAILURES } from "@anygriddb/core";
import { describe, expect, it } from "vitest";
import { known, knownText } from "./known-text";

describe("knownText", () => {
  it.each(BASE_TEMPLATES.map((template) => [template.id, template] as const))(
    "knows every word the template %s shows before a base is made",
    (_, template) => {
      const words = [
        template.name,
        template.description,
        ...template.tables.map((table) => table.name),
      ];
      for (const word of words) expect(knownText(word), word).toBeDefined();
    },
  );

  it.each(Object.values(OUTBOUND_FAILURES))(
    "knows the failure of a call out, %s, that a delivery keeps",
    (failure) => {
      expect(knownText(failure), failure).toBeDefined();
    },
  );

  it("shows a value it does not know as it is", () => {
    expect(knownText("Made by someone")).toBeUndefined();
    expect(known("Made by someone")).toEqual({
      id: "Made by someone",
      message: "Made by someone",
    });
  });
});
