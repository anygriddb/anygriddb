import { describe, expect, it } from "vitest";
import type { EngineCatalog, EngineTable } from "./engine";
import { buildReadRows } from "./read";

const customers: EngineTable = {
  id: "c",
  storage: "external",
  physicalName: "x_c",
  external: {
    sourceId: "s",
    dialect: "postgres",
    schema: "public",
    name: "customers",
    key: ["id"],
  },
  primaryColumn: "name",
  columns: [
    {
      id: "c1",
      name: "name",
      label: "Name",
      fieldType: "text",
      config: {},
      physical: {
        name: "Full Name",
        type: "character varying(200)",
        zone: "UTC",
      },
    },
  ],
};

const invoices: EngineTable = {
  id: "i",
  storage: "external",
  physicalName: "x_i",
  external: {
    sourceId: "s",
    dialect: "postgres",
    schema: "sales",
    name: "invoices",
    key: ["invoice_no"],
  },
  columns: [
    {
      id: "i1",
      name: "amount",
      label: "Amount",
      fieldType: "number",
      config: {},
      physical: { name: "amount", type: "numeric(12,2)", zone: "UTC" },
    },
    {
      id: "i3",
      name: "status",
      label: "Status",
      fieldType: "single_select",
      config: {},
      physical: { name: "status", type: "invoice_status", zone: "UTC" },
    },
    {
      id: "i4",
      name: "issued",
      label: "Issued",
      fieldType: "datetime",
      config: {},
      physical: {
        name: "issued",
        type: "timestamp(0) without time zone",
        zone: "Europe/Paris",
      },
    },
    {
      id: "i2",
      name: "customer",
      label: "Customer",
      fieldType: "relation_one_to_many",
      config: {},
      relation: {
        kind: "one_to_many",
        direction: "forward",
        targetTableId: "c",
        fkColumn: "customer_id",
      },
    },
  ],
};

const catalog: EngineCatalog = {
  table: invoices,
  tables: new Map([
    ["i", invoices],
    ["c", customers],
  ]),
  readable: () => true,
};

describe("reading a client's table", () => {
  it("reads its own table, names rows by their key, and joins on it", () => {
    const sql = buildReadRows(catalog, {
      rowIds: ["1001"],
      sort: [{ column: "amount", direction: "desc" }],
      limit: 50,
    }).text;
    expect(sql).toContain(`from "sales"."invoices" r`);
    expect(sql).toContain(`(r."invoice_no")::text as "id"`);
    // No system columns on a client table.
    expect(sql).toContain(`null::text as "ag_status"`);
    expect(sql).toContain(`null::bigint as "ag_seq"`);
    // The link joins the target's key to the foreign key, as stored.
    expect(sql).toContain(
      `from "public"."customers" t1 where t1."id" = r."customer_id"`,
    );
    expect(sql).toContain(`coalesce((t1."Full Name")::text, '')`);
    // Client columns read in their field's type; a numeric is one already.
    expect(sql).toContain(`r."amount"`);
    expect(sql).not.toContain(`(r."amount")::numeric`);
    expect(sql).toContain(`(r."status")::text`);
    // A date and time without a zone reads in the source's.
    expect(sql).toContain(`(r."issued" at time zone 'Europe/Paris')`);
    expect(sql).toContain(`'id', (t1."id")::text`);
    // Ids are text; ties break on the key.
    expect(sql).not.toContain("::uuid[]");
    expect(sql).toMatch(
      /order by q\."amount" desc nulls last, q\."ag_order_0" asc/,
    );
  });

  it("refuses to filter or sort a field kept in AnyGridDB inside the client query", () => {
    const kept: EngineCatalog = {
      ...catalog,
      table: {
        ...catalog.table,
        columns: [
          ...catalog.table.columns,
          {
            id: "i9",
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
      },
    };
    // Read, it is an empty placeholder the API fills after the page, in
    // the syntax of the engine the page is read from.
    expect(buildReadRows(kept, { limit: 10 }).text).toContain("null::text");
    const external = kept.table.external;
    if (!external) throw new Error("external table expected");
    const onMysql: EngineCatalog = {
      ...kept,
      table: { ...kept.table, external: { ...external, dialect: "mysql" } },
    };
    const mysql = buildReadRows(onMysql, { limit: 10 }).text;
    expect(mysql).toContain("cast(null as char)");
    expect(mysql).not.toContain("null::");
    const on = (op: "is" | "is_empty") => ({
      conjunction: "and" as const,
      conditions: [{ column: "note", op, value: "x" }],
    });
    expect(() => buildReadRows(kept, { limit: 1, filter: on("is") })).toThrow(
      expect.objectContaining({ code: "control_plane_filter" }),
    );
    expect(() =>
      buildReadRows(kept, {
        limit: 1,
        sort: [{ column: "note", direction: "asc" }],
      }),
    ).toThrow(expect.objectContaining({ code: "control_plane_sort" }));
  });

  it("excludes listed client row ids with a bound NOT IN", () => {
    const sql = buildReadRows(catalog, {
      excludeRowIds: ["1001", "1002"],
      limit: 50,
    });
    expect(sql.text).toMatch(/not \(.*q\."id".*\)/);
    expect(sql.values).toContain(JSON.stringify(["1001", "1002"]));
  });

  it("finds no row of AnyGridDB's own table under a text id", () => {
    const native: EngineTable = {
      id: "n",
      storage: "native",
      physicalName: "t_n",
      columns: [],
    };
    const statement = buildReadRows(
      { table: native, tables: new Map([["n", native]]), readable: () => true },
      { rowIds: ["1001", "0196f0c2-7b8e-7c3a-9f00-000000000001"], limit: 10 },
    );
    expect(statement.text).toContain("::uuid[]");
    expect(statement.values).toContain(
      JSON.stringify(["0196f0c2-7b8e-7c3a-9f00-000000000001"]),
    );
  });

  describe("an Oracle DATE read as a day", () => {
    const orders = (type: string): EngineCatalog => {
      const table: EngineTable = {
        id: "o",
        storage: "external",
        physicalName: "x_o",
        external: {
          sourceId: "s",
          dialect: "oracle",
          schema: "SALES",
          name: "ORDERS",
          key: ["ID"],
        },
        columns: [
          {
            id: "o1",
            name: "shipped",
            label: "Shipped",
            fieldType: "date",
            config: {},
            physical: { name: "SHIPPED", type, zone: "UTC" },
          },
        ],
      };
      return { table, tables: new Map([["o", table]]), readable: () => true };
    };
    const on = (op: "is" | "is_between", value: string | [string, string]) => ({
      conjunction: "and" as const,
      conditions: [{ column: "shipped", op, value }],
    });

    it("filters on the column as stored, so its index serves", () => {
      const exact = buildReadRows(orders("DATE"), {
        limit: 10,
        filter: on("is", "2026-11-07"),
      }).text;
      // The page still shows the day alone.
      expect(exact).toContain(`trunc(r."SHIPPED") as "shipped"`);
      expect(exact).toContain(`r."SHIPPED" as "ag_d0"`);
      expect(exact).toMatch(/q\."ag_d0" >= cast\(\S+ as date\)/);
      expect(exact).not.toMatch(/q\."shipped" >=/);
      const between = buildReadRows(orders("TIMESTAMP(6)"), {
        limit: 10,
        filter: on("is_between", ["2026-11-01", "2026-11-07"]),
      }).text;
      // A time on the last day is still within it.
      expect(between).toMatch(/q\."ag_d0" < \(cast\(\S+ as date\) \+ 1\)/);
      expect(between).not.toMatch(/q\."ag_d0" <=/);
    });

    it("keeps comparing the day where the stored value carries a zone", () => {
      const zoned = buildReadRows(orders("TIMESTAMP(6) WITH TIME ZONE"), {
        limit: 10,
        filter: on("is_between", ["2026-11-01", "2026-11-07"]),
      }).text;
      expect(zoned).not.toContain(`"ag_d0"`);
      expect(zoned).toMatch(/q\."shipped" <= cast\(\S+ as date\)/);
    });
  });
});
