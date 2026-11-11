import { describe, expect, it } from "vitest";
import {
  buildInsert,
  buildInsertLinks,
  buildInsertMany,
  buildInserts,
  buildReadStatuses,
  buildNonNullValues,
  buildRestoreRow,
  buildUpdate,
} from "./write";

const columns = [
  { name: "title", fieldType: "text" as const, config: {} },
  { name: "price", fieldType: "number" as const, config: {} },
  {
    name: "tags",
    fieldType: "multi_select" as const,
    config: { options: [{ name: "vip", color: "red" as const }] },
  },
  { name: "total", fieldType: "formula" as const, config: {} },
];

describe("write builders", () => {
  it("binds scalars and arrays with casts", () => {
    const insert = buildInsert({
      table: "t_orders",
      columns,
      values: { title: "A", price: 2, tags: ["vip"] },
    });
    expect(insert.text).toBe(
      `insert into "t_orders" ("title", "price", "tags") values ($1::text, $2::numeric, array(select jsonb_array_elements_text($3::text::jsonb))::text[]) returning "id"`,
    );
    expect(insert.values).toEqual(["A", 2, '["vip"]']);
    const update = buildUpdate({
      table: "t_orders",
      columns,
      id: "11111111-1111-4111-8111-111111111111",
      values: { price: null },
    });
    expect(update.text).toBe(
      `update "t_orders" set "price" = null where "id" = $1::uuid returning "id"`,
    );
  });

  it("writes rows that set the same fields in one statement, in their order", () => {
    const insert = buildInsertMany({
      table: "t_orders",
      columns,
      rows: [
        { title: "A", price: 2, tags: ["vip"] },
        { title: "B", price: null, tags: null },
      ],
    });
    expect(insert.text).toBe(
      `insert into "t_orders" ("title", "price", "tags") select "c0", "c1", "c2" from (values ($1::text, $2::numeric, array(select jsonb_array_elements_text($3::text::jsonb))::text[], 0), ($4::text, null::numeric, null::text[], 1)) as r ("c0", "c1", "c2", "n") order by "n" returning "id"`,
    );
    expect(insert.values).toEqual(["A", 2, '["vip"]', "B"]);
    // The same fields named in another order are the same row shape.
    expect(
      buildInsertMany({
        table: "t_orders",
        columns,
        rows: [
          { title: "A", price: 1 },
          { price: 2, title: "B" },
        ],
      }).values,
    ).toEqual(["A", 1, "B", 2]);
  });

  it("refuses rows of different fields, no rows, and computed columns in one statement", () => {
    expect(() =>
      buildInsertMany({
        table: "t_orders",
        columns,
        rows: [{ title: "A" }, { title: "B", price: 1 }],
      }),
    ).toThrow("Invalid column count");
    expect(() =>
      buildInsertMany({
        table: "t_orders",
        columns,
        rows: [{ title: "A" }, { price: 1 }],
      }),
    ).toThrow("Invalid column count");
    expect(() =>
      buildInsertMany({ table: "t_orders", columns, rows: [] }),
    ).toThrow("Invalid limit");
    expect(() =>
      buildInsertMany({ table: "t_orders", columns, rows: [{}] }),
    ).toThrow();
    expect(() =>
      buildInsertMany({ table: "t_orders", columns, rows: [{ total: "1" }] }),
    ).toThrow("Formula column is computed");
  });

  it("groups the rows that follow each other with the same fields", () => {
    const rows: Array<Record<string, string | number>> = [
      { title: "A" },
      { title: "B" },
      { title: "C", price: 1 },
      {},
      { title: "D" },
    ];
    const statements = buildInserts({ table: "t_orders", columns, rows });
    // Their order is kept: a row of other fields starts a new statement.
    expect(statements.map((item) => item.rows)).toEqual([2, 1, 1, 1]);
    expect(statements.map((item) => item.statement.values)).toEqual([
      ["A", "B"],
      ["C", 1],
      [],
      ["D"],
    ]);
    expect(statements[2]?.statement.text).toBe(
      `insert into "t_orders" default values returning "id"`,
    );
    expect(buildInserts({ table: "t_orders", columns, rows: [] })).toEqual([]);
    // A statement carries a bounded number of values.
    const many = buildInserts({
      table: "t_orders",
      columns,
      rows: Array.from({ length: 1_200 }, (_, index) => ({
        title: `Row ${String(index)}`,
      })),
    });
    expect(many.map((item) => item.rows)).toEqual([500, 500, 200]);
  });

  it("locks rows together, in the order of their ids", () => {
    const first = "aaaaaaaa-0000-4000-8000-000000000001";
    const second = "aaaaaaaa-0000-4000-8000-000000000002";
    const lock = buildReadStatuses({ table: "t_orders", ids: [second, first] });
    expect(lock.text).toBe(
      `select "id", "ag_status" from "t_orders" where "id" = any(array(select jsonb_array_elements_text($1::text::jsonb))::uuid[]) order by "id" for update`,
    );
    expect(lock.values).toEqual([JSON.stringify([second, first])]);
    expect(() => buildReadStatuses({ table: "t_orders", ids: [] })).toThrow(
      "Invalid limit",
    );
    expect(() =>
      buildReadStatuses({ table: "t_orders", ids: ["1 or 1=1"] }),
    ).toThrow("Invalid row id");
  });

  it("rejects computed columns, bad values, and bad ids", () => {
    expect(() =>
      buildInsert({ table: "t_orders", columns, values: { total: 1 } }),
    ).toThrow("Formula column is computed");
    expect(() =>
      buildInsert({ table: "t_orders", columns, values: { tags: ["nope"] } }),
    ).toThrow("Invalid cell");
    expect(() =>
      buildUpdate({
        table: "t_orders",
        columns,
        id: "1",
        values: { title: "x" },
      }),
    ).toThrow("Invalid row id");
    expect(() =>
      buildInsertLinks({
        junction: "j_x",
        leftIds: ["11111111-1111-4111-8111-111111111111"],
        rightIds: [],
      }),
    ).toThrow("Invalid link");
  });

  it("caps non-null value reads at the page limit", () => {
    const sql = buildNonNullValues({
      table: "t_orders",
      column: "files",
      limit: 1000,
      offset: 1000,
    });
    expect(sql.text).toContain("order by ctid limit $1 offset $2");
    expect(sql.values).toEqual([1000, 1000]);
    expect(() =>
      buildNonNullValues({ table: "t_orders", column: "files", limit: 1001 }),
    ).toThrow("Invalid limit");
    expect(() =>
      buildNonNullValues({
        table: "t_orders",
        column: "files",
        limit: 10,
        offset: -1,
      }),
    ).toThrow("Invalid limit");
  });

  it("restores a snapshot as a draft with its identity", () => {
    const restore = buildRestoreRow({
      table: "t_orders",
      columns: ["title"],
      snapshot: {
        id: "11111111-1111-4111-8111-111111111111",
        title: "A",
        ag_status: "locked",
      },
    });
    expect(restore.text).toContain(
      `("id", "ag_seq", "ag_created_at", "ag_created_by", "title")`,
    );
    expect(restore.text).not.toContain("ag_status");
    expect(() =>
      buildRestoreRow({ table: "t_orders", columns: [], snapshot: {} }),
    ).toThrow("Invalid row id");
  });
});
