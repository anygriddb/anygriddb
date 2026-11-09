import { describe, expect, it } from "vitest";
import {
  applyViewConfigPatch,
  normalizeViewConfig,
  pruneViewConfig,
  viewConfigColumns,
} from "./view-config";

describe("normalizeViewConfig", () => {
  it("maps pre-v2 keys and drops invalid values", () => {
    const config = normalizeViewConfig(
      {
        filters: [{ column: "status", op: "eq", value: "Open" }],
        hiddenColumns: ["notes"],
        groupColumn: "status",
        dateColumn: "due",
        rowHeight: "giant",
        frozenColumns: 2,
      },
      "grid",
    );
    expect(config).toEqual({
      filter: {
        conjunction: "and",
        conditions: [{ column: "status", op: "is", value: "Open" }],
      },
      hiddenFields: ["notes"],
      stackColumn: "status",
      groupBy: [{ column: "status", direction: "asc" }],
      startColumn: "due",
      frozenColumns: 2,
    });
    expect(normalizeViewConfig(null)).toEqual({});
  });

  it("keeps folded kanban stacks and a description, and drops bad ones", () => {
    expect(
      normalizeViewConfig({
        collapsedStacks: ["Done", ""],
        description: "  Tickets ouverts cette semaine  ",
      }),
    ).toEqual({
      collapsedStacks: ["Done", ""],
      description: "Tickets ouverts cette semaine",
    });
    expect(
      normalizeViewConfig({
        collapsedStacks: "Done",
        description: "x".repeat(1_001),
      }),
    ).toEqual({});
  });

  it("patches with null removal and lists referenced columns", () => {
    const next = applyViewConfigPatch(
      { rowHeight: "tall", frozenColumns: 1 },
      { rowHeight: null, frozenColumns: 2 },
    );
    expect(next).toEqual({ frozenColumns: 2 });
    expect(
      viewConfigColumns({
        sort: [{ column: "a", direction: "asc" }],
        filter: {
          conjunction: "and",
          conditions: [
            {
              conjunction: "or",
              conditions: [{ column: "b", op: "is_empty" }],
            },
          ],
        },
        stackColumn: "c",
      }).sort(),
    ).toEqual(["a", "b", "c"]);
  });
});

describe("stripColumnFromConfig", () => {
  it("drops every reference to a deleted column and keeps the rest", async () => {
    const { stripColumnFromConfig } = await import("./view-config");
    const next = stripColumnFromConfig(
      {
        filter: {
          conjunction: "and",
          conditions: [
            { column: "gone", op: "is_empty" },
            {
              conjunction: "or",
              conditions: [{ column: "gone", op: "is_not_empty" }],
            },
            { column: "kept", op: "is_empty" },
          ],
        },
        sort: [{ column: "gone", direction: "asc" }],
        hiddenFields: ["gone", "kept"],
        stackColumn: "gone",
      },
      "gone",
    );
    expect(next).toEqual({
      filter: {
        conjunction: "and",
        conditions: [{ column: "kept", op: "is_empty" }],
      },
      sort: [],
      hiddenFields: ["kept"],
    });
  });
});

describe("pruneViewConfig", () => {
  const config = normalizeViewConfig({
    filter: {
      conjunction: "and",
      conditions: [
        { column: "statut", op: "is", value: "Ouvert" },
        { column: "gone", op: "is_empty" },
      ],
    },
    sort: [{ column: "gone", direction: "asc" }],
    fieldOrder: ["nom", "gone", "statut"],
    hiddenFields: ["gone"],
    columnWidths: { gone: 200, nom: 120 },
    stackColumn: "gone",
  });

  it("drops every reference to a column the view cannot see", () => {
    const pruned = pruneViewConfig(config, new Set(["nom", "statut"]));
    expect(viewConfigColumns(pruned)).not.toContain("gone");
    expect(pruned.fieldOrder).toEqual(["nom", "statut"]);
    expect(pruned.hiddenFields).toEqual([]);
    expect(pruned.columnWidths).toEqual({ nom: 120 });
    expect(pruned.stackColumn).toBeUndefined();
    expect(pruned.filter?.conditions).toHaveLength(1);
  });

  it("leaves a config that only names known columns as it was", () => {
    const pruned = pruneViewConfig(config, new Set(["nom", "statut", "gone"]));
    expect(pruned).toEqual(config);
  });
});
