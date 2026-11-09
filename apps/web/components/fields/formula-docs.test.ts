import { checkFormula, FORMULA_FNS } from "@anygriddb/core";
import { describe, expect, it } from "vitest";
import { FORMULA_DOCS, formulaGroups } from "./formula-docs";

/** The fields an example reads, as the editor would offer them. */
function refsOf(example: string) {
  return [...example.matchAll(/\{([^{}]+)\}/g)].map((match) => ({
    name: (match[1] ?? "").toLowerCase(),
    label: match[1] ?? "",
  }));
}

describe("formula help", () => {
  it("gives every function an example that parses and calls it", () => {
    for (const fn of FORMULA_FNS) {
      const { example } = FORMULA_DOCS[fn];
      expect(checkFormula(example, refsOf(example)), example).toBeNull();
      expect(example, fn).toContain(`${fn.toUpperCase()}(`);
    }
  });

  it("lists each function once, in one group", () => {
    const listed = formulaGroups().flatMap((group) => group.fns);
    expect(new Set(listed).size).toBe(listed.length);
    expect([...listed].sort()).toEqual([...FORMULA_FNS].sort());
  });
});
