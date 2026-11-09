import { describe, expect, it } from "vitest";
import { resolveShortcuts } from "./shortcut-list";

const bases = [
  {
    id: "b1",
    name: "CRM",
    tables: [
      { id: "t1", name: "Clients" },
      { id: "t2", name: "Ventes" },
    ],
  },
] as never[];

describe("shortcuts", () => {
  it("resolves pins and recent tables against the catalog", () => {
    const resolved = resolveShortcuts(bases, {
      pinnedBases: ["b1"],
      pinnedTables: ["t2"],
      recentTables: [{ tableId: "t1", openedAt: "2026-11-08T20:00:00.000Z" }],
    });
    expect(
      resolved.pinned.map((item) =>
        item.kind === "base" ? item.base.id : item.table.id,
      ),
    ).toEqual(["b1", "t2"]);
    expect(resolved.recent.map((item) => item.table.name)).toEqual(["Clients"]);
  });

  it("leaves out what the person can no longer open", () => {
    const resolved = resolveShortcuts(bases, {
      pinnedBases: ["gone"],
      pinnedTables: ["t9"],
      recentTables: [{ tableId: "t9", openedAt: "2026-11-08T20:00:00.000Z" }],
    });
    expect(resolved).toEqual({ pinned: [], recent: [] });
    expect(resolveShortcuts(bases, undefined)).toEqual({
      pinned: [],
      recent: [],
    });
  });
});
