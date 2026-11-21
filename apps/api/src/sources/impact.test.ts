import { describe, expect, it } from "vitest";
import { summarizeSourceImpact } from "./impact.js";

describe("summarizeSourceImpact", () => {
  it("counts blocked sources and live versus synced tables", () => {
    const impact = summarizeSourceImpact({
      sources: [{ host: "erp.internal" }, { host: "lab.example" }],
      tables: [{ synced: false }, { synced: true }, { synced: true }],
      hostedBases: 1,
      allows: (host) => host === "erp.internal",
    });
    expect(impact).toEqual({
      sources: 2,
      blockedSources: 1,
      exposedTables: 3,
      syncedTables: 2,
      liveTables: 1,
      hostedBases: 1,
    });
  });

  it("is empty when nothing is declared", () => {
    expect(
      summarizeSourceImpact({
        sources: [],
        tables: [],
        hostedBases: 0,
        allows: () => false,
      }),
    ).toEqual({
      sources: 0,
      blockedSources: 0,
      exposedTables: 0,
      syncedTables: 0,
      liveTables: 0,
      hostedBases: 0,
    });
  });
});
