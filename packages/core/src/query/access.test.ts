import { describe, expect, it } from "vitest";
import type { FilterGroup } from "../filter";
import type { EngineAccess, EngineCatalog } from "./engine";
import {
  CLIENTS_ID,
  ORDERS_ID,
  SECRET_ID,
  catalogFor,
} from "./fixtures.test-helpers";
import {
  buildAggregates,
  buildCountRows,
  buildGroupCounts,
  buildReadRows,
} from "./read";

function withAccess(access: Partial<EngineAccess>): EngineCatalog {
  return {
    ...catalogFor(),
    access: {
      hidden: () => false,
      readOnly: () => false,
      rowFilter: () => undefined,
      ...access,
    },
  };
}

function rule(column: string, op: string, value: unknown): FilterGroup {
  return {
    conjunction: "and",
    conditions: [{ column, op, value } as FilterGroup["conditions"][number]],
  };
}

/** Every `$n` in the text is bound, and every bound value is used. */
function expectBound(sql: { text: string; values: readonly unknown[] }): void {
  const used = new Set(
    [...sql.text.matchAll(/\$(\d+)/g)].map((match) => Number(match[1])),
  );
  expect([...used].sort((a, b) => a - b)).toEqual(
    sql.values.map((_, index) => index + 1),
  );
}

describe("field access", () => {
  it("compiles a hidden field to empty in the page, formulas, filters, and sorts", () => {
    const catalog = withAccess({
      hidden: (tableId, column) => tableId === ORDERS_ID && column === "price",
    });
    const sql = buildReadRows(catalog, {
      limit: 10,
      filter: rule("price", "gt", 100),
      sort: [{ column: "price", direction: "desc" }],
      search: "42",
    });
    expect(sql.text).not.toContain(`r."price"`);
    expect(sql.text).toContain(`null::numeric as "price"`);
    // The formula over the hidden price cannot reveal it either.
    expect(sql.text).toContain(`(null::numeric * r."qty") as "total"`);
    expectBound(sql);
  });

  it("hides a linked table's field from lookups and link labels", () => {
    const catalog = withAccess({
      hidden: (tableId, column) =>
        tableId === CLIENTS_ID && (column === "city" || column === "name"),
    });
    const sql = buildReadRows(catalog, { limit: 10 });
    expect(sql.text).not.toMatch(/t\d+\."city"/);
    expect(sql.text).not.toMatch(/t\d+\."name"/);
    expectBound(sql);
  });

  it("hides a link field itself", () => {
    const catalog = withAccess({
      hidden: (tableId, column) => tableId === ORDERS_ID && column === "codes",
    });
    const sql = buildReadRows(catalog, { limit: 10, fields: ["codes"] });
    expect(sql.text).toContain(`'[]'::jsonb as "codes"`);
    expectBound(sql);
  });

  it("drops the bound values of a hidden field", () => {
    const catalog = withAccess({
      hidden: (tableId, column) =>
        tableId === ORDERS_ID && column === "created",
    });
    const sql = buildReadRows(catalog, {
      limit: 10,
      timeZone: "Europe/Paris",
    });
    expectBound(sql);
  });

  it("blanks a rollup of a hidden field, and still counts the links", () => {
    const base = withAccess({
      hidden: (tableId, column) => tableId === SECRET_ID && column === "code",
    });
    const catalog: EngineCatalog = {
      ...base,
      readable: () => true,
      table: {
        ...base.table,
        columns: [
          ...base.table.columns,
          {
            id: "o20",
            name: "code_filled",
            label: "Codes filled",
            fieldType: "rollup",
            config: { relation: "codes", target: "code", fn: "counta" },
          },
        ],
      },
    };
    const sql = buildReadRows(catalog, {
      limit: 10,
      fields: ["code_count", "code_filled"],
    });
    // Not a total of nothing: the reader may not see what it would add.
    expect(sql.text).toContain(`null::numeric as "code_filled"`);
    expect(sql.text).toMatch(
      /count\(\*\)::numeric from [^)]*\) as "code_count"/,
    );
    expect(sql.text).not.toMatch(/t\d+\."code"/);
    expectBound(sql);
  });
});

describe("row access", () => {
  it("keeps only the rule's rows on the table itself, reading real values", () => {
    const catalog = withAccess({
      // The rule reads a field the reader cannot see: it still applies.
      hidden: (tableId, column) => tableId === ORDERS_ID && column === "status",
      rowFilter: (tableId) =>
        tableId === ORDERS_ID ? rule("status", "is", "Open") : undefined,
    });
    const sql = buildReadRows(catalog, { limit: 10 });
    expect(sql.text).toContain(
      `from "t_orders" r where r."id" in (select q."id" from (select r."id", r."status" as "status" from "t_orders" r) q where`,
    );
    expect(sql.values).toContain("Open");
    expectBound(sql);
  });

  it("restricts links, lookups, and rollups to the linked table's rule", () => {
    const catalog = withAccess({
      rowFilter: (tableId) =>
        tableId === CLIENTS_ID ? rule("city", "is", "Paris") : undefined,
    });
    const sql = buildReadRows(catalog, { limit: 10 });
    const scoped = sql.text.match(
      /t\d+\."id" in \(select q\."id" from \(select r\."id", r\."city" as "city" from "t_clients" r\) q where/g,
    );
    // The link labels and the city lookup both read clients.
    expect(scoped?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(sql.values.filter((value) => value === "Paris").length).toBe(
      scoped?.length,
    );
    expectBound(sql);
  });

  it("keeps no row when the rule no longer compiles", () => {
    const catalog = withAccess({
      rowFilter: (tableId) =>
        tableId === ORDERS_ID ? rule("gone", "is", "x") : undefined,
    });
    const sql = buildReadRows(catalog, {
      limit: 10,
      timeZone: "Europe/Paris",
    });
    expect(sql.text).toContain(`from "t_orders" r where false) q`);
    expect(sql.values).not.toContain("x");
    expectBound(sql);
  });

  it("substitutes the reader for me", () => {
    const catalog = withAccess({
      me: "00000000-0000-4000-8000-0000000000aa",
      rowFilter: (tableId) =>
        tableId === ORDERS_ID ? rule("title", "is", "me") : undefined,
    });
    const sql = buildReadRows(catalog, { limit: 10 });
    expectBound(sql);
  });

  it("scopes counts, groups, and aggregates the same way", () => {
    const catalog = withAccess({
      rowFilter: (tableId) =>
        tableId === ORDERS_ID ? rule("status", "is", "Open") : undefined,
    });
    const spec = { groupBy: [{ column: "status", direction: "asc" as const }] };
    for (const sql of [
      buildCountRows(catalog, spec),
      buildGroupCounts(catalog, spec),
      buildAggregates(catalog, spec, [{ column: "price", fn: "sum" }]),
    ]) {
      expect(sql?.text).toContain(`from "t_orders" r where r."id" in (`);
      if (sql) expectBound(sql);
    }
  });
});
