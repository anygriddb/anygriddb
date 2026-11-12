import { describe, expect, it } from "vitest";
import {
  applyViewConfigPatch,
  keepTrashedParts,
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

describe("keepTrashedParts", () => {
  const trashed = new Set(["notes"]);
  const stored = normalizeViewConfig({
    fieldOrder: ["name", "notes", "status", "due"],
    hiddenFields: ["notes"],
    columnWidths: { name: 200, notes: 320 },
    aggregations: { notes: "count_filled" },
    sort: [
      { column: "notes", direction: "desc" },
      { column: "name", direction: "asc" },
    ],
    filter: {
      conjunction: "and",
      conditions: [
        { column: "status", op: "is", value: "Done" },
        { column: "notes", op: "is_not_empty" },
      ],
    },
    form: {
      title: "Ask",
      fields: [{ column: "name" }, { column: "notes", required: true }],
    },
  });

  it("keeps a trashed field's place and settings in what a person saved", () => {
    // What a person saved, having seen the view without "notes".
    const saved = applyViewConfigPatch(stored, {
      fieldOrder: ["due", "name", "status"],
      hiddenFields: null,
      columnWidths: { name: 240 },
      aggregations: null,
      sort: [{ column: "status", direction: "asc" }],
      filter: {
        conjunction: "or",
        conditions: [{ column: "status", op: "is", value: "To do" }],
      },
      form: { title: "Ask again", fields: [{ column: "status" }] },
    });
    const kept = keepTrashedParts(stored, saved, trashed, [
      "fieldOrder",
      "hiddenFields",
      "columnWidths",
      "aggregations",
      "sort",
      "filter",
      "form",
    ]);
    expect(kept.fieldOrder).toEqual(["due", "name", "notes", "status"]);
    expect(kept.hiddenFields).toEqual(["notes"]);
    expect(kept.columnWidths).toEqual({ name: 240, notes: 320 });
    expect(kept.aggregations).toEqual({ notes: "count_filled" });
    expect(kept.sort).toEqual([
      { column: "notes", direction: "desc" },
      { column: "status", direction: "asc" },
    ]);
    expect(kept.filter).toEqual({
      conjunction: "and",
      conditions: [
        {
          conjunction: "or",
          conditions: [{ column: "status", op: "is", value: "To do" }],
        },
        { column: "notes", op: "is_not_empty" },
      ],
    });
    expect(kept.form).toEqual({
      title: "Ask again",
      fields: [{ column: "notes", required: true }, { column: "status" }],
    });
    // Without the field in the trash, the person sees what they saved.
    const seen = pruneViewConfig(kept, new Set(["name", "status", "due"]));
    expect(seen.fieldOrder).toEqual(saved.fieldOrder);
    expect(seen.hiddenFields).toEqual([]);
    expect(seen.columnWidths).toEqual(saved.columnWidths);
    expect(seen.sort).toEqual(saved.sort);
    expect(seen.filter).toEqual(saved.filter);
    expect(seen.form?.fields?.map((field) => field.column)).toEqual(["status"]);
  });

  it("leaves what was not saved, and fields that are not in the trash", () => {
    const saved = applyViewConfigPatch(stored, {
      fieldOrder: ["status", "name", "due"],
    });
    expect(keepTrashedParts(stored, saved, new Set(), ["fieldOrder"])).toBe(
      saved,
    );
    const kept = keepTrashedParts(stored, saved, trashed, ["rowHeight"]);
    expect(kept.fieldOrder).toEqual(["status", "name", "due"]);
    // A whole configuration saved keeps them in every setting.
    const whole = keepTrashedParts(
      stored,
      { rowHeight: "tall" },
      trashed,
      "all",
    );
    expect(whole.hiddenFields).toEqual(["notes"]);
    expect(whole.columnWidths).toEqual({ notes: 320 });
    // Saved twice, nothing is put back twice.
    const twice = keepTrashedParts(
      stored,
      keepTrashedParts(stored, saved, trashed, ["fieldOrder", "filter"]),
      trashed,
      ["fieldOrder", "filter"],
    );
    expect(twice.fieldOrder).toEqual(["status", "name", "notes", "due"]);
    expect(twice.filter?.conditions).toHaveLength(2);
  });

  it("drops what no longer fits a setting's limits", () => {
    const full = Array.from({ length: 10 }, (_, index) => ({
      column: `f${String(index)}`,
      direction: "asc" as const,
    }));
    const saved = applyViewConfigPatch(stored, { sort: full });
    expect(keepTrashedParts(stored, saved, trashed, ["sort"]).sort).toEqual(
      full,
    );
  });
});
