import { describe, expect, it } from "vitest";
import { roleRank, type Role } from "@anygriddb/core";

/**
 * Mirrors the origin pick in admin-access: highest role wins; a person's
 * own binding beats a group at the same rank.
 */
function pickOrigin(
  rows: Array<{
    role: Role;
    groupId: string | null;
    groupName: string | null;
  }>,
): { role: Role | null; origin: string } {
  let best: Role | null = null;
  let origin = "none";
  for (const row of rows) {
    const rank = roleRank(row.role);
    const bestRank = best ? roleRank(best) : 0;
    const direct = row.groupId === null;
    const better =
      rank > bestRank || (rank === bestRank && direct && origin !== "direct");
    if (!better) continue;
    best = row.role;
    origin = direct ? "direct" : (row.groupName ?? "");
  }
  return { role: best, origin };
}

describe("effective rights origin", () => {
  it("keeps the highest role", () => {
    expect(
      pickOrigin([
        { role: "viewer", groupId: "g1", groupName: "Team" },
        { role: "editor", groupId: null, groupName: null },
      ]),
    ).toEqual({ role: "editor", origin: "direct" });
  });

  it("prefers a direct binding when ranks match", () => {
    expect(
      pickOrigin([
        { role: "editor", groupId: "g1", groupName: "Team" },
        { role: "editor", groupId: null, groupName: null },
      ]),
    ).toEqual({ role: "editor", origin: "direct" });
  });

  it("names the group when only a group gives the role", () => {
    expect(
      pickOrigin([{ role: "viewer", groupId: "g1", groupName: "Finance" }]),
    ).toEqual({ role: "viewer", origin: "Finance" });
  });

  it("says none when there is no binding", () => {
    expect(pickOrigin([])).toEqual({ role: null, origin: "none" });
  });
});
