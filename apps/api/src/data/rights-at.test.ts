import type { Permission } from "@anygriddb/core";
import { describe, expect, it } from "vitest";
import {
  rightsAtCsv,
  rightsAtCsvCell,
  type RightsAtLine,
} from "./rights-at.js";

describe("rightsAtCsv", () => {
  it("writes one row per line with the group that gives the role", () => {
    const lines: RightsAtLine[] = [
      {
        scope: "base",
        scopeId: "b1",
        role: "editor",
        madeRole: null,
        groupId: "g1",
        groupName: "Finance",
        eventId: "e1",
        occurredAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    const csv = rightsAtCsv(
      {
        incomplete: false,
        at: "2026-06-01T00:00:00.000Z",
        lines,
      },
      new Map([["b1", { base: "Ledger" }]]),
    );
    expect(csv).toContain("Finance");
    expect(csv).toContain("Ledger");
    expect(csv).toContain("editor");
    // What the role gave, by the permissions' keys, last.
    expect(csv.split("\n")[0]?.endsWith(",permissions")).toBe(true);
    expect(csv).toContain(`"rows.read rows.comment rows.write`);
  });

  it("gives a made role's permissions then, and none the trail no longer says", () => {
    const line = (permissions: Permission[] | null): RightsAtLine => ({
      scope: "base",
      scopeId: "b1",
      role: null,
      madeRole: { id: "m1", name: "Checker", permissions },
      groupId: null,
      groupName: null,
      eventId: null,
      occurredAt: null,
    });
    const csv = rightsAtCsv(
      {
        incomplete: false,
        at: "2026-06-01T00:00:00.000Z",
        lines: [line(["rows.read", "rows.comment"]), line(null)],
      },
      new Map(),
    );
    const [, then, unknown] = csv.split("\n");
    expect(then?.endsWith(`,"rows.read rows.comment"`)).toBe(true);
    expect(unknown?.endsWith(`,""`)).toBe(true);
  });

  it("quotes a formula and a quote so a spreadsheet does not run them", () => {
    expect(rightsAtCsvCell(`=cmd|' /C calc'!A0`)).toBe(`"'=cmd|' /C calc'!A0"`);
    expect(rightsAtCsvCell(`Say "hi"`)).toBe(`"Say ""hi"""`);
    const csv = rightsAtCsv(
      {
        incomplete: false,
        at: "2026-06-01T00:00:00.000Z",
        lines: [
          {
            scope: "base",
            scopeId: "b1",
            role: "viewer",
            madeRole: null,
            groupId: "g1",
            groupName: "=1+1",
            eventId: null,
            occurredAt: null,
          },
        ],
      },
      new Map([["b1", { base: `Led "ger"` }]]),
    );
    expect(csv).toContain(`"'=1+1"`);
    expect(csv).toContain(`"Led ""ger"""`);
    expect(csv).not.toContain(`,"=1+1",`);
  });
});
