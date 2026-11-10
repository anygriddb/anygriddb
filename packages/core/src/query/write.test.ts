import { describe, expect, it } from "vitest";
import {
  buildInsert,
  buildInsertLinks,
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
