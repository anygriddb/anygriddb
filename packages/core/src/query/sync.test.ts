import { describe, expect, it } from "vitest";
import type { EngineColumn, EngineTable } from "./engine";
import {
  buildCopyCreate,
  buildCopyInsert,
  buildCopyUpsert,
  buildCopySwap,
  copyColumns,
  copyRow,
  copyTable,
} from "./sync";

const TABLE_ID = "01a1bb33-cdda-724a-ad41-7b2a0c980c42";

function column(
  name: string,
  fieldType: string,
  extra: Partial<EngineColumn> = {},
): EngineColumn {
  return {
    id: name,
    name: `f_${name}`,
    label: name,
    fieldType,
    physical: { name, type: "text", zone: "UTC" },
    ...extra,
  } as EngineColumn;
}

const table = {
  id: TABLE_ID,
  storage: "external",
  physicalName: "x",
  external: {
    sourceId: "s",
    dialect: "mysql",
    schema: "erp",
    name: "order_lines",
    key: ["order_id", "line_no"],
  },
  columns: [
    column("order_id", "relation_one_to_many", {
      relation: {
        kind: "one_to_many",
        direction: "forward",
        targetTableId: "o",
      },
    }),
    column("line_no", "number"),
    column("product_id", "relation_one_to_many", {
      relation: {
        kind: "one_to_many",
        direction: "forward",
        targetTableId: "p",
      },
    }),
    column("qty", "number"),
    column("shipped", "datetime"),
    column("total", "formula", { physical: undefined }),
  ],
} as unknown as EngineTable;

const declared = new Map([
  ["order_id", "int"],
  ["line_no", "smallint unsigned"],
  ["product_id", "varchar(12)"],
  ["qty", "decimal(10,2)"],
  ["shipped", "datetime(3)"],
]);

describe("copies of synced tables", () => {
  it("keeps the id, the key, and each stored field in AnyGridDB's types", () => {
    expect(
      copyColumns(table, declared).map((item) => [item.name, item.type]),
    ).toEqual([
      ["ag_id", "text"],
      ["order_id", "bigint"],
      ["line_no", "bigint"],
      ["product_id", "text"],
      ["qty", "numeric"],
      ["shipped", "timestamptz"],
    ]);
  });

  it("takes the key from the id and a link's key from its cell", () => {
    const columns = copyColumns(table, declared);
    expect(
      copyRow(
        columns,
        {
          id: "[7, 2]",
          f_order_id: [{ id: "7", label: "Order 7" }],
          f_line_no: "2",
          f_product_id: "SKU-1",
          f_qty: "3.50",
          f_shipped: null,
          f_total: "99",
        },
        ["7", "2"],
      ),
    ).toEqual({
      ag_id: "[7, 2]",
      order_id: "7",
      line_no: "2",
      product_id: "SKU-1",
      qty: "3.50",
      shipped: null,
    });
  });

  it("loads beside the copy, then swaps names and indexes", () => {
    const columns = copyColumns(table, declared);
    const next = copyTable(TABLE_ID, true);
    const current = copyTable(TABLE_ID);
    expect(current).toBe("t_01a1bb33cdda724aad417b2a0c980c42");
    const created = buildCopyCreate(TABLE_ID, columns).map((s) => s.text);
    expect(created[1]).toContain(
      `constraint "${next}_pkey" primary key ("ag_id")`,
    );
    expect(created.slice(2)).toEqual([
      // A foreign key in the key is indexed by the key's index.
      `create index "${next}_k" on "ag_sync"."${next}" ("order_id", "line_no")`,
      `create index "${next}_f0" on "ag_sync"."${next}" ("product_id")`,
    ]);
    expect(buildCopyInsert(TABLE_ID, columns, []).text).toContain(
      'on conflict ("ag_id") do nothing',
    );
    expect(buildCopyUpsert(TABLE_ID, columns, []).text).toContain(
      'on conflict ("ag_id") do update set',
    );
    expect(buildCopySwap(TABLE_ID, columns).map((s) => s.text)).toEqual([
      `drop table if exists "ag_sync"."${current}"`,
      `alter table "ag_sync"."${next}" rename to "${current}"`,
      `alter index "ag_sync"."${next}_pkey" rename to "${current}_pkey"`,
      `alter index "ag_sync"."${next}_k" rename to "${current}_k"`,
      `alter index "ag_sync"."${next}_f0" rename to "${current}_f0"`,
    ]);
  });
});
