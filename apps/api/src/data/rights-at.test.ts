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
