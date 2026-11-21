import { describe, expect, it } from "vitest";
import { blockedSourceTables, keepsCopy } from "./source-reach";
import type { CatalogTable } from "../../lib/types";

type External = NonNullable<CatalogTable["external"]>;

function external(hostAllowed: boolean, synced = false): External {
  return {
    schema: "public",
    name: "orders",
    engine: "postgres",
    source: { id: "s1", name: "ERP" },
    hosted: false,
    hostAllowed,
    writes: { update: false, insert: false, delete: false },
    enrichable: false,
    enrichment: "off",
    enrichmentBlocked: null,
    synced: synced
      ? { at: "2026-11-20T12:00:00.000Z", intervalMinutes: 15 }
      : null,
  };
}

function table(
  id: string,
  name: string,
  ext: CatalogTable["external"],
): CatalogTable {
  return {
    id,
    name,
    description: null,
    position: 0,
    folderId: null,
    trailReads: false,
    role: "viewer",
    columns: [],
    external: ext,
  };
}

describe("keepsCopy", () => {
  it("is true only once a first copy has arrived", () => {
    expect(keepsCopy(table("c", "Copied", external(false, true)))).toBe(true);
    const waiting = external(false, true);
    waiting.synced = { at: null, intervalMinutes: 15 };
    expect(keepsCopy(table("w", "Waiting", waiting))).toBe(false);
    expect(keepsCopy(table("l", "Live", external(false)))).toBe(false);
  });
});

describe("blockedSourceTables", () => {
  it("counts a table once, however many widgets read it", () => {
    const blocked = table("b", "Blocked", external(false));
    expect(blockedSourceTables([blocked, blocked, blocked])).toHaveLength(1);
  });

  it("keeps only external tables whose host is not allowed", () => {
    const native = table("n", "Native", null);
    const blocked = table("b", "Blocked", external(false));
    const ok = table("o", "Ok", external(true));
    expect(
      blockedSourceTables([native, blocked, ok]).map((row) => row.id),
    ).toEqual(["b"]);
  });
});
