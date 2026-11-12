import { randomBytes } from "node:crypto";
import {
  buildAddForeignKeyColumn,
  buildAggregates,
  buildCountRows,
  buildCreateJunction,
  buildCreateTable,
  buildGroupCounts,
  buildInsert,
  buildReadRows,
  buildRestoreRow,
  parseFormula,
  type EngineCatalog,
  type EngineColumn,
  type EngineTable,
} from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase } from "../test-database.js";
import { runRows, withAudit } from "./audit-context.js";

const suffix = randomBytes(6).toString("hex");
const clientsId = "aaaaaaaa-0000-4000-8000-000000000001";
const ordersId = "aaaaaaaa-0000-4000-8000-000000000002";

const clients: EngineTable = {
  id: clientsId,
  storage: "native",
  physicalName: `t_clients_${suffix}`,
  primaryColumn: "name",
  columns: [
    { id: "c1", name: "name", label: "Name", fieldType: "text", config: {} },
    { id: "c2", name: "city", label: "City", fieldType: "text", config: {} },
    {
      id: "c3",
      name: "score",
      label: "Score",
      fieldType: "number",
      config: {},
    },
  ],
};

const base: EngineColumn[] = [
  { id: "o1", name: "title", label: "Title", fieldType: "text", config: {} },
  { id: "o2", name: "price", label: "Price", fieldType: "number", config: {} },
  { id: "o3", name: "qty", label: "Qty", fieldType: "number", config: {} },
  {
    id: "o4",
    name: "status",
    label: "Status",
    fieldType: "single_select",
    config: {
      options: [
        { name: "Open", color: "green" },
        { name: "Closed", color: "gray" },
      ],
    },
  },
  {
    id: "o5",
    name: "tags",
    label: "Tags",
    fieldType: "multi_select",
    config: {
      options: [
        { name: "vip", color: "red" },
        { name: "new", color: "blue" },
      ],
    },
  },
  { id: "o6", name: "due", label: "Due", fieldType: "date", config: {} },
  { id: "o7", name: "done", label: "Done", fieldType: "boolean", config: {} },
  {
    id: "o8",
    name: "client",
    label: "Client",
    fieldType: "relation_one_to_many",
    config: {},
    relation: {
      kind: "one_to_many",
      direction: "forward",
      targetTableId: clientsId,
      fkColumn: "client",
    },
  },
  {
    id: "o9",
    name: "partners",
    label: "Partners",
    fieldType: "relation_many_to_many",
    config: {},
    relation: {
      kind: "many_to_many",
      direction: "forward",
      targetTableId: clientsId,
      junction: `j_partners_${suffix}`,
    },
  },
  {
    id: "o10",
    name: "client_city",
    label: "Client city",
    fieldType: "lookup",
    config: { relation: "client", target: "city" },
  },
  {
    id: "o11",
    name: "partner_score",
    label: "Partner score",
    fieldType: "rollup",
    config: { relation: "partners", target: "score", fn: "sum" },
  },
];

const formulas: Array<[string, string]> = [
  ["total", "{Price} * {Qty}"],
  ["label", '{Title} & " (" & {Status} & ")"'],
  ["guarded", "SQRT(-1) & LN(0) & POWER(-8, 0.5) & MOD(1, 0) & ({Price} / 0)"],
  ["dates", "DATETIME_DIFF(DATE_ADD({Due}, 10, 'days'), {Due}, 'days')"],
  [
    "texts",
    "UPPER(LEFT({Title}, 2)) & REPT('-', 2) & SUBSTITUTE({Title}, 'a', 'b')",
  ],
  ["sw", "SWITCH({Status}, 'Open', 1, 'Closed', 2, 0)"],
  ["lookups", "ARRAY_JOIN({Client city}) & '|' & {Partner score}"],
  ["nested", "{Total} * 2"],
  // Text read as dates by AnyGridDB's grammar, in the reader's zone.
  [
    "textdates",
    'DATETIME_DIFF("2026-03-01", "2026-02-28", "days") & "|" & YEAR("2026-02-30") & "|" & DATETIME_DIFF("2026-01-10T10:00:00Z", "2026-01-10 09:30", "minutes") & "|" & DATETIME_DIFF("2026-01-10T09:59:00+02:00", "2026-01-10 09:00", "minutes") & "|" & DATETIME_DIFF("2026-01-10T12:00+0530", "2026-01-10T06:30Z", "minutes")',
  ],
];

function ordersTable(): EngineTable {
  const refs = [
    ...base.map((column) => ({ name: column.name, label: column.label })),
    ...formulas.map(([name]) => ({
      name,
      label: name[0]?.toUpperCase() + name.slice(1),
    })),
  ];
  return {
    id: ordersId,
    storage: "native",
    physicalName: `t_orders_${suffix}`,
    primaryColumn: "title",
    columns: [
      ...base,
      ...formulas.map(([name, source]) => ({
        id: `f_${name}`,
        name,
        label: name[0]?.toUpperCase() + name.slice(1),
        fieldType: "formula" as const,
        config: { expr: parseFormula(source, refs) },
      })),
    ],
  };
}

describe("read engine on PostgreSQL", () => {
  const orders = ordersTable();
  const catalog: EngineCatalog = {
    table: orders,
    tables: new Map([[clientsId, clients]]),
    readable: () => true,
  };
  let database: Database;
  let pool: pg.Pool;
  let close: (() => Promise<void>) | undefined;
  const query = async <Row extends Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<Row[]> => (await pool.query<Row>(text, [...values])).rows;
  let userId = "";
  let firstOrder = "";

  beforeAll(async () => {
    const created = await createTestDatabase("engine");
    database = created.db;
    pool = created.pool;
    close = created.close;
    for (const statement of [
      ...buildCreateTable({
        table: clients.physicalName,
        columns: clients.columns,
      }),
      ...buildCreateTable({
        table: orders.physicalName,
        columns: orders.columns,
      }),
      buildAddForeignKeyColumn({
        table: orders.physicalName,
        column: "client",
        targetTable: clients.physicalName,
      }),
      ...buildCreateJunction({
        junction: `j_partners_${suffix}`,
        leftTable: orders.physicalName,
        rightTable: clients.physicalName,
      }),
    ]) {
      await query(statement.text);
    }
    const user = await database
      .insertInto("users")
      .values({ email: `engine-${suffix}@example.com`, displayName: "Engine" })
      .returning("id")
      .executeTakeFirst();
    userId = user?.id ?? "";
    const writeClient = (values: Record<string, string | number>) =>
      withAudit(database, { userId, tableId: clientsId }, (tx) =>
        runRows(
          tx,
          buildInsert({
            table: clients.physicalName,
            columns: clients.columns,
            values,
          }),
        ),
      );
    const acme = String(
      (await writeClient({ name: "Acme", city: "Paris", score: 5 }))[0]?.id,
    );
    const beta = String(
      (await writeClient({ name: "Beta", city: "Lyon", score: 7 }))[0]?.id,
    );
    const writable = orders.columns.filter((column) =>
      ["title", "price", "qty", "status", "tags", "due", "done"].includes(
        column.name,
      ),
    );
    const inserted = await withAudit(
      database,
      { userId, tableId: ordersId },
      async (tx) => {
        const first = await runRows(
          tx,
          buildInsert({
            table: orders.physicalName,
            columns: writable,
            values: {
              title: "abc",
              price: 4,
              qty: 3,
              status: "Open",
              tags: ["vip", "new"],
              due: "2026-11-01",
              done: true,
            },
          }),
        );
        await runRows(
          tx,
          buildInsert({
            table: orders.physicalName,
            columns: writable,
            values: { title: "zz", price: 1, qty: 0, status: "Closed" },
          }),
        );
        return first;
      },
    );
    firstOrder = String(inserted[0]?.id);
    await withAudit(database, { userId, tableId: ordersId }, async (tx) => {
      await runRows(tx, {
        text: `update "${orders.physicalName}" set "client" = $1 where "id" = $2 returning "id"`,
        values: [acme, firstOrder],
      });
      await runRows(tx, {
        text: `insert into "j_partners_${suffix}" values ($1, $2), ($1, $3)`,
        values: [firstOrder, acme, beta],
      });
    });
  });

  afterAll(async () => {
    await close?.();
  });

  it("computes formulas, links, lookups, and rollups in one query", async () => {
    const statement = buildReadRows(catalog, {
      limit: 10,
      sort: [{ column: "total", direction: "desc" }],
      timeZone: "Europe/Paris",
    });
    const rows = await query(statement.text, statement.values);
    const row = rows[0] as Record<string, unknown>;
    // Computed numbers are exact: they read as decimal text (ADR 0023).
    expect(row).toMatchObject({
      title: "abc",
      total: "12",
      label: "abc (Open)",
      guarded: "",
      dates: "10",
      texts: "AB--bbc",
      sw: "1",
      client_city: ["Paris"],
      partner_score: "12",
      lookups: "Paris|12",
      nested: "24",
      textdates: "1||90|-1|0",
      tags: ["vip", "new"],
      client: [{ id: expect.any(String), label: "Acme" }],
    });
    expect(rows[1]).toMatchObject({
      title: "zz",
      total: "0",
      client: [],
      partners: [],
      // A sum of no linked rows is a total: 0, as a count is.
      partner_score: "0",
    });
  });

  it("filters, counts, groups, and aggregates", async () => {
    const filter = {
      conjunction: "and" as const,
      conditions: [
        { column: "tags", op: "has_all_of" as const, value: ["vip"] },
        { column: "client", op: "contains" as const, value: "acm" },
        { column: "total", op: "gte" as const, value: 12 },
        {
          column: "due",
          op: "is_on_or_after" as const,
          value: { mode: "exact" as const, date: "2026-10-01" },
        },
        {
          conjunction: "or" as const,
          conditions: [
            { column: "client_city", op: "contains" as const, value: "par" },
            { column: "title", op: "is_empty" as const },
          ],
        },
      ],
    };
    const page = buildReadRows(catalog, { limit: 10, filter, search: "ab" });
    expect(await query(page.text, page.values)).toHaveLength(1);
    const count = buildCountRows(catalog, {});
    expect((await query(count.text, count.values))[0]?.total).toBe(2);
    const groups = buildGroupCounts(catalog, {
      groupBy: [
        { column: "status", direction: "asc" },
        { column: "client", direction: "asc" },
      ],
    });
    expect(groups).not.toBeNull();
    if (groups) {
      const grouped = await query(groups.text, groups.values);
      expect(grouped.filter((group) => group.depth === 1)).toHaveLength(2);
    }
    // Where each group starts: the place of its first row in the read.
    const groupBy = [{ column: "status", direction: "desc" as const }];
    const placed = buildGroupCounts(catalog, { groupBy }, { starts: true });
    const ordered = buildReadRows(catalog, { limit: 10, groupBy });
    const read = await query(ordered.text, ordered.values);
    for (const group of await query(placed?.text ?? "", placed?.values ?? [])) {
      expect(group.span).toBe(group.count);
      expect(read[Number(group.start)]?.status).toEqual(group.k0);
    }
    const aggregates = buildAggregates(catalog, {}, [
      { column: "total", fn: "sum" },
      { column: "done", fn: "percent_checked" },
      { column: "client", fn: "percent_filled" },
    ]);
    expect((await query(aggregates.text, aggregates.values))[0]).toEqual({
      // The sum of an exact number is decimal text (ADR 0023).
      a0: "12",
      a1: 50,
      a2: 50,
    });
  });

  it("restores a deleted row from its audit snapshot as a draft", async () => {
    const writable = [
      "title",
      "price",
      "qty",
      "status",
      "tags",
      "due",
      "done",
      "client",
    ];
    await withAudit(database, { userId, tableId: ordersId }, (tx) =>
      runRows(tx, {
        text: `delete from "${orders.physicalName}" where "id" = $1 returning "id"`,
        values: [firstOrder],
      }),
    );
    const [event] = await query<{ old_value: Record<string, unknown> }>(
      `select old_value from audit_events where record_id = $1::uuid and action = 'delete'`,
      [firstOrder],
    );
    expect(event).toBeTruthy();
    if (!event) {
      return;
    }
    await withAudit(
      database,
      { userId, tableId: ordersId, source: "restore" },
      (tx) =>
        runRows(
          tx,
          buildRestoreRow({
            table: orders.physicalName,
            columns: writable,
            snapshot: event.old_value,
          }),
        ),
    );
    const statement = buildReadRows(catalog, {
      limit: 1,
      rowIds: [firstOrder],
    });
    const [restored] = await query(statement.text, statement.values);
    expect(restored).toMatchObject({
      title: "abc",
      ag_status: "draft",
      ag_seq: 1,
      total: "12",
    });
    expect(() =>
      buildRestoreRow({
        table: orders.physicalName,
        columns: writable,
        snapshot: { title: "no id" },
      }),
    ).toThrow("Invalid row id");
  });
});
