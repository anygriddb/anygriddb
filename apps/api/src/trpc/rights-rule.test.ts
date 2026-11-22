import { describe, expect, it } from "vitest";
import { RIGHTS_CHANGES } from "./rights-rule.js";
import { appRouter } from "./router.js";

const PROCEDURES = appRouter._def.procedures as unknown as Record<
  string,
  { _def: { type: "query" | "mutation" | "subscription" } }
>;

describe("the calls that change what a socket may hear", () => {
  it.each([...RIGHTS_CHANGES])("names a real change: %s", (path) => {
    expect(PROCEDURES[path]?._def.type).toBe("mutation");
  });

  it("names none of the calls that only read", () => {
    expect(RIGHTS_CHANGES.has("catalog.members")).toBe(false);
  });
});
