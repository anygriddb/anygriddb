import { describe, expect, it } from "vitest";
import { looksLikeAddress, unmetNeed } from "./form-needs";

describe("unmetNeed", () => {
  it("lets a form go when nothing is wanting", () => {
    expect(
      unmetNeed([
        { missing: false, say: "Give the group a name.", field: "name" },
        { missing: false, say: "Choose a scope." },
      ]),
    ).toBeNull();
    expect(unmetNeed([])).toBeNull();
  });

  it("says the first need still wanting, in the form's order", () => {
    expect(
      unmetNeed([
        { missing: false, say: "Give the token a name.", field: "name" },
        { missing: true, say: "Choose a scope.", field: "scopes" },
        { missing: true, say: "Give an address.", field: "uri" },
      ]),
    ).toEqual({ missing: true, say: "Choose a scope.", field: "scopes" });
  });
});

describe("looksLikeAddress", () => {
  it("takes something on each side of an @", () => {
    expect(looksLikeAddress("ada@example.org")).toBe(true);
    expect(looksLikeAddress("a@b")).toBe(true);
  });

  it("refuses what the browser refused", () => {
    for (const text of [
      "",
      "ada",
      "@example.org",
      "ada@",
      "ada @example.org",
    ]) {
      expect(looksLikeAddress(text)).toBe(false);
    }
  });
});
