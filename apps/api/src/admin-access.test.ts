import { describe, expect, it } from "vitest";
import type { Given } from "@anygriddb/core";
import { rightsOn, type SourcedOrigin } from "./admin-access.js";

function origin(
  role: Given,
  group: SourcedOrigin["group"] = null,
): SourcedOrigin {
  return {
    scope: "base",
    role: typeof role === "string" ? role : role.id,
    madeName: typeof role === "string" ? null : role.name,
    group,
    endsAt: null,
    narrows: false,
    binding: { role, scope: "base", scopeId: "b" },
  };
}

describe("rightsOn", () => {
  it("names each permission held with every attribution that gives it", () => {
    const rights = rightsOn([
      origin("viewer", { id: "g", name: "Finance" }),
      origin({
        id: "m",
        name: "Reviewer",
        permissions: ["rows.read", "rows.comment"],
      }),
    ]);
    expect(rights.origins.map((one) => one.madeName ?? one.role)).toEqual([
      "viewer",
      "Reviewer",
    ]);
    expect(rights.permissions).toEqual([
      { permission: "rows.read", from: [0, 1] },
      { permission: "rows.comment", from: [1] },
      { permission: "data.export", from: [0] },
      { permission: "api.access", from: [0] },
    ]);
    // What the decision reads stays on the server.
    expect(rights.origins[0]).not.toHaveProperty("binding");
  });

  it("holds nothing where no attribution reaches", () => {
    expect(rightsOn([])).toEqual({ origins: [], permissions: [] });
  });
});
