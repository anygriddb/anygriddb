import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineCatalog, EngineTable } from "@anygriddb/core";

const enrichmentKeysMatching = vi.hoisted(() =>
  vi.fn<
    (
      db: unknown,
      tableId: string,
      fieldId: string,
      match: { op: string; value?: unknown },
      limit: number,
    ) => Promise<string[]>
  >(),
);

vi.mock("./enrichment-values.js", () => ({
  enrichmentKeysMatching,
}));

import {
  applyControlPlaneReadSpec,
  enrichmentExclusionSource,
  enrichmentMatchFromCondition,
  enrichmentMatchIsExclusion,
  intersectRowIds,
  stripControlPlaneFilter,
  unionRowIds,
} from "./control-plane-read-filter.js";

const NOTE_ID = "field-note";

function externalCatalog(): EngineCatalog {
  const table: EngineTable = {
    id: "t-ext",
    storage: "external",
    physicalName: "x_t",
    external: {
      sourceId: "s",
      dialect: "postgres",
      schema: "public",
      name: "items",
      key: ["id"],
    },
    primaryColumn: "name",
    columns: [
      {
        id: "c-name",
        name: "name",
        label: "Name",
        fieldType: "text",
        config: {},
        physical: { name: "name", type: "text", zone: "UTC" },
      },
      {
        id: NOTE_ID,
        name: "note",
        label: "Note",
        fieldType: "text",
        config: {},
        physical: {
          name: "note",
          type: "text",
          zone: "UTC",
          controlPlane: true,
        },
      },
    ],
  };
  return {
    table,
    tables: new Map([[table.id, table]]),
    readable: () => true,
  };
}

describe("stripControlPlaneFilter", () => {
  it("keeps client leaves and collects control-plane ones", () => {
    const isCp = (name: string) => name === "note";
    const { filter, removed } = stripControlPlaneFilter(
      {
        conjunction: "and",
        conditions: [
          { column: "name", op: "is", value: "Ada" },
          { column: "note", op: "is", value: "vip" },
          {
            conjunction: "and",
            conditions: [{ column: "note", op: "is_not_empty" }],
          },
        ],
      },
      isCp,
    );
    expect(removed).toEqual([
      { column: "note", op: "is", value: "vip" },
      { column: "note", op: "is_not_empty" },
    ]);
    expect(filter).toEqual({
      conjunction: "and",
      conditions: [{ column: "name", op: "is", value: "Ada" }],
    });
  });

  it("returns undefined when every leaf was control-plane", () => {
    const { filter, removed } = stripControlPlaneFilter(
      {
        conjunction: "and",
        conditions: [{ column: "note", op: "is_empty" }],
      },
      (name) => name === "note",
    );
    expect(filter).toBeUndefined();
    expect(removed).toHaveLength(1);
  });
});

describe("enrichmentMatchFromCondition", () => {
  it("maps equality and emptiness ops", () => {
    expect(
      enrichmentMatchFromCondition(
        { column: "note", op: "is", value: "x" },
        "field-1",
      ),
    ).toEqual({ fieldId: "field-1", match: { op: "eq", value: "x" } });
    expect(
      enrichmentMatchFromCondition(
        { column: "note", op: "is_not", value: "x" },
        "field-1",
      ),
    ).toEqual({ fieldId: "field-1", match: { op: "not_eq", value: "x" } });
    expect(
      enrichmentMatchFromCondition(
        { column: "note", op: "is_empty" },
        "field-1",
      ),
    ).toEqual({ fieldId: "field-1", match: { op: "blank" } });
    expect(
      enrichmentMatchFromCondition(
        { column: "note", op: "is_not_empty" },
        "field-1",
      ),
    ).toEqual({ fieldId: "field-1", match: { op: "not_blank" } });
  });

  it("rejects unsupported ops", () => {
    expect(() =>
      enrichmentMatchFromCondition(
        { column: "note", op: "contains", value: "x" },
        "field-1",
      ),
    ).toThrow(/kept in AnyGridDB/);
  });
});

describe("intersectRowIds / unionRowIds", () => {
  it("intersects with an existing list or copies when none", () => {
    expect(intersectRowIds(undefined, ["a", "b"])).toEqual(["a", "b"]);
    expect(intersectRowIds(["a", "c"], ["a", "b"])).toEqual(["a"]);
    expect(intersectRowIds(["a"], ["b"])).toEqual([]);
  });

  it("unions without duplicates", () => {
    expect(unionRowIds(["a"], ["a", "b"])).toEqual(["a", "b"]);
  });
});

describe("enrichmentMatchIsExclusion", () => {
  it("marks blank and not_eq as exclusion", () => {
    expect(enrichmentMatchIsExclusion({ op: "blank" })).toBe(true);
    expect(enrichmentMatchIsExclusion({ op: "not_eq", value: "x" })).toBe(true);
    expect(enrichmentMatchIsExclusion({ op: "eq", value: "x" })).toBe(false);
    expect(enrichmentMatchIsExclusion({ op: "not_blank" })).toBe(false);
  });

  it("maps exclusion matches to their positive opposite", () => {
    expect(enrichmentExclusionSource({ op: "blank" })).toEqual({
      op: "not_blank",
    });
    expect(enrichmentExclusionSource({ op: "not_eq", value: "vip" })).toEqual({
      op: "eq",
      value: "vip",
    });
    expect(enrichmentExclusionSource({ op: "eq", value: "vip" })).toEqual({
      op: "eq",
      value: "vip",
    });
  });
});

describe("applyControlPlaneReadSpec", () => {
  const db = {} as never;

  beforeEach(() => {
    enrichmentKeysMatching.mockReset();
  });

  it("leaves a spec without control-plane filters alone", async () => {
    const engine = externalCatalog();
    const spec = {
      limit: 50,
      filter: {
        conjunction: "and" as const,
        conditions: [{ column: "name", op: "is" as const, value: "Ada" }],
      },
    };
    await expect(applyControlPlaneReadSpec(db, engine, spec)).resolves.toBe(
      spec,
    );
    expect(enrichmentKeysMatching).not.toHaveBeenCalled();
  });

  it("resolves inclusion filters to rowIds and strips the leaf", async () => {
    enrichmentKeysMatching.mockResolvedValueOnce(["r1", "r2"]);
    const next = await applyControlPlaneReadSpec(db, externalCatalog(), {
      limit: 50,
      filter: {
        conjunction: "and",
        conditions: [
          { column: "name", op: "is", value: "Ada" },
          { column: "note", op: "is", value: "vip" },
        ],
      },
    });
    expect(enrichmentKeysMatching).toHaveBeenCalledWith(
      db,
      "t-ext",
      NOTE_ID,
      { op: "eq", value: "vip" },
      expect.any(Number),
    );
    expect(next).toEqual({
      limit: 50,
      rowIds: ["r1", "r2"],
      filter: {
        conjunction: "and",
        conditions: [{ column: "name", op: "is", value: "Ada" }],
      },
    });
  });

  it("resolves is_empty via excludeRowIds of non-blank bags", async () => {
    enrichmentKeysMatching.mockResolvedValueOnce(["filled"]);
    const next = await applyControlPlaneReadSpec(db, externalCatalog(), {
      limit: 50,
      filter: {
        conjunction: "and",
        conditions: [{ column: "note", op: "is_empty" }],
      },
    });
    expect(enrichmentKeysMatching).toHaveBeenCalledWith(
      db,
      "t-ext",
      NOTE_ID,
      { op: "not_blank" },
      expect.any(Number),
    );
    expect(next).toEqual({
      limit: 50,
      excludeRowIds: ["filled"],
    });
  });

  it("resolves is_not via excludeRowIds of the matching value", async () => {
    enrichmentKeysMatching.mockResolvedValueOnce(["vip-row"]);
    const next = await applyControlPlaneReadSpec(db, externalCatalog(), {
      limit: 50,
      filter: {
        conjunction: "and",
        conditions: [{ column: "note", op: "is_not", value: "vip" }],
      },
    });
    expect(enrichmentKeysMatching).toHaveBeenCalledWith(
      db,
      "t-ext",
      NOTE_ID,
      { op: "eq", value: "vip" },
      expect.any(Number),
    );
    expect(next).toEqual({
      limit: 50,
      excludeRowIds: ["vip-row"],
    });
  });

  it("returns null when inclusion matches nothing", async () => {
    enrichmentKeysMatching.mockResolvedValueOnce([]);
    await expect(
      applyControlPlaneReadSpec(db, externalCatalog(), {
        limit: 50,
        filter: {
          conjunction: "and",
          conditions: [{ column: "note", op: "is", value: "missing" }],
        },
      }),
    ).resolves.toBeNull();
  });

  it("rejects a control-plane leaf under OR", async () => {
    await expect(
      applyControlPlaneReadSpec(db, externalCatalog(), {
        limit: 50,
        filter: {
          conjunction: "or",
          conditions: [
            { column: "name", op: "is", value: "Ada" },
            { column: "note", op: "is", value: "vip" },
          ],
        },
      }),
    ).rejects.toThrow(/kept in AnyGridDB/);
  });
});
