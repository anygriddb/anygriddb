import { describe, expect, it } from "vitest";
import { sourceReachable, summarizeSourceImpact } from "./impact.js";

const allows = (host: string) => host === "erp.internal";

describe("sourceReachable", () => {
  it("needs the primary and a configured replica on the list", () => {
    expect(sourceReachable(allows, { host: "erp.internal" })).toBe(true);
    expect(sourceReachable(allows, { host: "lab.example" })).toBe(false);
    expect(
      sourceReachable(allows, {
        host: "erp.internal",
        replicaHost: "replica.internal",
        replicaPort: 5432,
      }),
    ).toBe(false);
  });

  it("ignores a replica with no port, which no connection uses", () => {
    expect(
      sourceReachable(allows, {
        host: "erp.internal",
        replicaHost: "replica.internal",
        replicaPort: null,
      }),
    ).toBe(true);
  });
});

describe("summarizeSourceImpact", () => {
  const table = (sourceId: string, patch = {}) => ({
    sourceId,
    synced: false,
    hasCopy: false,
    hosted: false,
    ...patch,
  });

  it("says what a blocked source leaves, apart from the totals", () => {
    const impact = summarizeSourceImpact({
      sources: [
        { id: "open", host: "erp.internal" },
        { id: "shut", host: "lab.example" },
      ],
      tables: [
        table("open"),
        table("open", { synced: true, hasCopy: true }),
        table("shut"),
        table("shut", { synced: true, hasCopy: true }),
        // Synced, no copy yet: it is read live, and so refused.
        table("shut", { synced: true }),
        // A hosted base's table is counted with its base.
        table("shut", { hosted: true }),
      ],
      hostedBases: [{ sourceId: "shut" }, { sourceId: "open" }],
      allows,
    });
    expect(impact).toEqual({
      sources: 2,
      blockedSources: 1,
      liveTables: 2,
      syncedTables: 3,
      hostedBases: 2,
      unreachableTables: 2,
      frozenTables: 1,
      unreachableBases: 1,
    });
  });

  it("is empty when nothing is declared", () => {
    expect(
      summarizeSourceImpact({
        sources: [],
        tables: [],
        hostedBases: [],
        allows: () => false,
      }),
    ).toEqual({
      sources: 0,
      blockedSources: 0,
      liveTables: 0,
      syncedTables: 0,
      hostedBases: 0,
      unreachableTables: 0,
      frozenTables: 0,
      unreachableBases: 0,
    });
  });
});
