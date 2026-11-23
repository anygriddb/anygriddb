import { describe, expect, it } from "vitest";
import type { EngineColumn, EngineTable } from "./engine";
import {
  buildCopyCreate,
  buildCopyDiff,
  buildCopyInsert,
  buildCopyUpsert,
  buildCopySwap,
  copyColumns,
  copyRow,
  copyStoredRow,
  copyTable,
  fitCopyValue,
  type CopyColumn,
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

  it("keeps a JSON document as the text it arrives as", () => {
    // A document reaches the copy as its text: kept as jsonb, the copy
    // would hold a JSON string of it, and read it back in quotes.
    const documented = {
      ...table,
      columns: [
        ...table.columns,
        column("details", "json", {
          physical: { name: "details", type: "json", zone: "UTC" },
        }),
      ],
    } as unknown as EngineTable;
    expect(
      copyColumns(documented, declared)
        .map((item) => [item.name, item.type])
        .at(-1),
    ).toEqual(["details", "text"]);
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

describe("a row of a store that speaks no SQL", () => {
  it("keeps a value that fits its column as it came", () => {
    expect(fitCopyValue("text", "Ada")).toBe("Ada");
    // PostgreSQL's text holds no NUL character.
    expect(fitCopyValue("text", "a\u0000b")).toBe("ab");
    expect(fitCopyValue("text", 12)).toBe("12");
    expect(fitCopyValue("text", false)).toBe("false");
    expect(fitCopyValue("numeric", 12.5)).toBe(12.5);
    expect(fitCopyValue("numeric", "9007199254740993")).toBe(
      "9007199254740993",
    );
    expect(fitCopyValue("numeric", "1.10")).toBe("1.10");
    expect(fitCopyValue("numeric", "-1E+3")).toBe("-1E+3");
    expect(fitCopyValue("bigint", 42)).toBe(42);
    expect(fitCopyValue("bigint", "-9223372036854775808")).toBe(
      "-9223372036854775808",
    );
    expect(fitCopyValue("boolean", true)).toBe(true);
    expect(fitCopyValue("date", "2024-02-29")).toBe("2024-02-29");
    expect(fitCopyValue("timestamptz", "2026-01-10T09:30:00.250Z")).toBe(
      "2026-01-10T09:30:00.250Z",
    );
    expect(fitCopyValue("timestamptz", "2026-01-10T09:30:00+02:00")).toBe(
      "2026-01-10T09:30:00+02:00",
    );
    for (const type of ["text", "numeric", "bigint", "boolean", "date"]) {
      expect(fitCopyValue(type, null)).toBeNull();
    }
  });

  it("says which value does not fit, where PostgreSQL would refuse the page", () => {
    expect(fitCopyValue("numeric", "to be confirmed")).toBeUndefined();
    expect(fitCopyValue("numeric", Number.NaN)).toBeUndefined();
    expect(fitCopyValue("numeric", Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(fitCopyValue("numeric", "1e99999")).toBeUndefined();
    expect(fitCopyValue("numeric", `0${"0".repeat(990)}x`)).toBeUndefined();
    expect(fitCopyValue("numeric", "1".repeat(1_001))).toBeUndefined();
    expect(fitCopyValue("numeric", "5.")).toBe("5.");
    expect(fitCopyValue("numeric", ".5")).toBe(".5");
    expect(fitCopyValue("numeric", true)).toBeUndefined();
    expect(fitCopyValue("bigint", 1.5)).toBeUndefined();
    expect(fitCopyValue("bigint", "9223372036854775808")).toBeUndefined();
    expect(fitCopyValue("bigint", "abc")).toBeUndefined();
    expect(fitCopyValue("boolean", "true")).toBeUndefined();
    expect(fitCopyValue("date", "2026-02-30")).toBeUndefined();
    expect(fitCopyValue("date", "10/01/2026")).toBeUndefined();
    expect(fitCopyValue("timestamptz", "2026-01-10 09:30")).toBeUndefined();
    expect(fitCopyValue("timestamptz", "2026-13-01T00:00:00Z")).toBeUndefined();
    expect(fitCopyValue("timestamptz", "0000-01-01T00:00:00Z")).toBeUndefined();
    // A type no copy of such a store has.
    expect(fitCopyValue("uuid[]", "x")).toBeUndefined();
  });

  it("is stored under the store's own names, and counts what read empty", () => {
    const columns: CopyColumn[] = [
      { name: "ag_id", type: "text", source: { kind: "id" } },
      { name: "_id", type: "text", source: { kind: "key", index: 0 } },
      {
        name: "amount",
        type: "numeric",
        source: { kind: "field", name: "f_amount", link: false },
      },
      {
        name: "paid",
        type: "boolean",
        source: { kind: "field", name: "f_paid", link: false },
      },
      // A field named like a row's own id is a field like another.
      {
        name: "id",
        type: "text",
        source: { kind: "field", name: "f_id", link: false },
      },
    ];
    expect(
      copyStoredRow(columns, "a1", {
        _id: "a1",
        amount: "12.50",
        paid: true,
        id: "theirs",
        unknown: "left out",
      }),
    ).toEqual({
      row: {
        ag_id: "a1",
        _id: "a1",
        amount: "12.50",
        paid: true,
        id: "theirs",
      },
      misfits: 0,
    });
    expect(
      copyStoredRow(columns, "a2", { _id: "a2", amount: "n/a", paid: "yes" }),
    ).toEqual({
      row: { ag_id: "a2", _id: "a2", amount: null, paid: null, id: null },
      misfits: 2,
    });
  });
});

describe("buildCopyDiff", () => {
  /** How many arguments each `jsonb_build_object` of a statement is given. */
  function argumentCounts(text: string): number[] {
    return text
      .split("jsonb_build_object(")
      .slice(1)
      .map((call) => {
        const inner = call.slice(0, call.indexOf(")"));
        return inner === "" ? 0 : inner.split(", ").length;
      });
  }

  const names = (count: number) =>
    Array.from({ length: count }, (_, index) => `c${String(index)}`);

  it.each([1, 40, 41, 49, 50, 51, 300])(
    "compares %i columns without passing a call's limit of arguments",
    (count) => {
      const { text } = buildCopyDiff(TABLE_ID, names(count), 201);
      const counts = argumentCounts(text);
      expect(Math.max(...counts)).toBeLessThanOrEqual(100);
      // Both sides name every column once.
      expect(counts.reduce((sum, item) => sum + item, 0)).toBe(count * 4);
      for (const name of names(count)) {
        expect(text).toContain(`n."${name}"`);
        expect(text).toContain(`o."${name}"`);
      }
    },
  );

  it("still compares a table with no column in common", () => {
    const { text } = buildCopyDiff(TABLE_ID, [], 201);
    expect(text).toContain("jsonb_build_object() is distinct from");
  });

  it("escapes a column's name as a key of the comparison", () => {
    const { text } = buildCopyDiff(TABLE_ID, ["it's"], 201);
    expect(text).toContain(`'it''s', n."it's"`);
  });
});
