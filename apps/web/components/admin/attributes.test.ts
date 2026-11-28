import { describe, expect, it } from "vitest";
import { attributeKeyOf, scimFieldOf } from "./attributes";

describe("an attribute's key, from its name", () => {
  it("keeps letters and digits, drops accents, joins words", () => {
    expect(attributeKeyOf("Ward")).toBe("ward");
    expect(attributeKeyOf("  Service hospitalier 2 ")).toBe(
      "service_hospitalier_2",
    );
    expect(attributeKeyOf("Établissement / site")).toBe("etablissement_site");
    expect(attributeKeyOf("x".repeat(60))).toHaveLength(40);
  });

  it("gives none for a name that does not start with a letter", () => {
    for (const name of ["", "  ", "2nd floor", "——", "東京"]) {
      expect(attributeKeyOf(name)).toBeNull();
    }
  });
});

describe("scimFieldOf", () => {
  it("names a field of the enterprise extension, and none for anything else", () => {
    expect(scimFieldOf("department")).toBe("department");
    expect(scimFieldOf("")).toBeNull();
    expect(scimFieldOf("manager")).toBeNull();
  });
});
