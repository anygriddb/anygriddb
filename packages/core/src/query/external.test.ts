import { describe, expect, it } from "vitest";
import type { FormulaExpr } from "../formula";
import type { EngineCatalog, EngineTable } from "./engine";
import {
  aggregatesOfField,
  buildAggregates,
  buildGroupAggregates,
  buildReadRows,
  describeColumns,
  type ReadSpec,
} from "./read";

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

  describe("a page that starts after a row", () => {
    const held = {
      sourceId: "s",
      dialect: "sqlserver" as const,
      schema: "dbo",
      name: "lines",
      key: ["region", "no"],
    };
    const lines: EngineTable = {
      id: "l",
      storage: "external",
      physicalName: "x_l",
      external: held,
      columns: [
        {
          id: "l1",
          name: "region",
          label: "Region",
          fieldType: "text",
          config: {},
          physical: { name: "region", type: "varchar(8)", zone: "UTC" },
        },
        {
          id: "l2",
          name: "no",
          label: "No",
          fieldType: "number",
          config: {},
          physical: { name: "no", type: "int", zone: "UTC" },
        },
      ],
    };
    const read = (table: EngineTable, spec: Partial<ReadSpec>) =>
      buildReadRows(
        { table, tables: new Map([[table.id, table]]), readable: () => true },
        { limit: 1000, ...spec },
      );

    it("starts after its key, in the key's order, and not at a count", () => {
      const single = buildReadRows(catalog, { after: "1000", limit: 1000 });
      expect(single.text).toContain(`((q."ag_order_0" > $1))`);
      expect(single.values[0]).toBe("1000");
      expect(single.text).toMatch(/order by q\."ag_order_0" asc/);
      // Two columns: each compared in its own type on SQL Server.
      const pair = read(lines, { after: '{"k0":"eu","k1":7}' });
      expect(pair.text).toContain(
        `((q."ag_order_0" > cast($1 as varchar(8))) or (q."ag_order_0" = cast($1 as varchar(8)) and q."ag_order_1" > cast($2 as int)))`,
      );
      expect(pair.values.slice(0, 2)).toEqual(["eu", "7"]);
      // Without a key, rows are in their content's order.
      const keyless = read(
        { ...lines, external: { ...held, key: [] } },
        { after: "0cc175b9c0f1b6a831c399e269772661" },
      );
      expect(keyless.text).toContain(`q."ag_order_0" > $1`);
    });

    it("refuses to start after a row of its own table, or in another order", () => {
      const native: EngineTable = {
        id: "n",
        storage: "native",
        physicalName: "t_n",
        columns: [],
      };
      expect(() => read(native, { after: "x" })).toThrow(
        expect.objectContaining({ code: "invalid_offset" }),
      );
      expect(() =>
        read(lines, {
          after: '{"k0":"eu","k1":7}',
          sort: [{ column: "no", direction: "desc" }],
        }),
      ).toThrow(expect.objectContaining({ code: "invalid_offset" }));
      // A client's copy is read in AnyGridDB's database, in its own order.
      expect(() =>
        read(
          { ...lines, external: { ...held, synced: true } },
          { after: '{"k0":"eu","k1":7}' },
        ),
      ).toThrow(expect.objectContaining({ code: "invalid_offset" }));
      // An id that names no key is no row to start after.
      expect(() => read(lines, { after: "7" })).toThrow(
        expect.objectContaining({ code: "invalid_row_id" }),
      );
    });
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

  describe("a type its field cannot hold whole", () => {
    const numberColumn = (
      dialect: "sqlserver" | "oracle" | "mysql" | "mariadb",
      physicalType: string,
      name = "amount",
    ): EngineCatalog => {
      const table: EngineTable = {
        id: "n",
        storage: "external",
        physicalName: "x_n",
        external: {
          sourceId: "s",
          dialect,
          schema: dialect === "sqlserver" ? "dbo" : "SALES",
          name: "NUMBERS",
          key: ["ID"],
        },
        columns: [
          {
            id: "n1",
            name,
            label: "Amount",
            fieldType: "number",
            config: {},
            physical: {
              name: name.toUpperCase(),
              type: physicalType,
              zone: "UTC",
            },
          },
        ],
      };
      return { table, tables: new Map([["n", table]]), readable: () => true };
    };

    it("reads a SQL Server float past decimal(38,10) empty, and says so", () => {
      const sql = buildReadRows(numberColumn("sqlserver", "float"), {
        limit: 10,
      }).text;
      expect(sql).toContain(
        `(case when abs(r."AMOUNT") < 1e28 and (r."AMOUNT" = 0 or abs(r."AMOUNT") >= 1e-30) then cast(r."AMOUNT" as decimal(38,10)) end) as "amount"`,
      );
      expect(sql).toContain(
        `(case when not (abs(r."AMOUNT") < 1e28 and (r."AMOUNT" = 0 or abs(r."AMOUNT") >= 1e-30)) then convert(varchar(32), r."AMOUNT", 2) end)`,
      );
    });

    it("reads an Oracle binary float the same way", () => {
      const sql = buildReadRows(numberColumn("oracle", "binary_double"), {
        limit: 10,
      }).text;
      expect(sql).toContain(
        `(case when abs(r."AMOUNT") < 1e28 and (r."AMOUNT" = 0 or abs(r."AMOUNT") >= 1e-30) then cast(r."AMOUNT" as number(38,10)) end) as "amount"`,
      );
      expect(sql).toContain(
        `(case when r."AMOUNT" is not null and not (abs(r."AMOUNT") < 1e28 and (r."AMOUNT" = 0 or abs(r."AMOUNT") >= 1e-30)) then '!' || to_char(r."AMOUNT") end)`,
      );
    });

    it("reads SQL Server geography as its well-known text", () => {
      const table: EngineTable = {
        id: "g",
        storage: "external",
        physicalName: "x_g",
        external: {
          sourceId: "s",
          dialect: "sqlserver",
          schema: "dbo",
          name: "PLACES",
          key: ["ID"],
        },
        columns: [
          {
            id: "g1",
            name: "shape",
            label: "Shape",
            fieldType: "text",
            config: {},
            physical: { name: "SHAPE", type: "geography", zone: "UTC" },
          },
        ],
      };
      const sql = buildReadRows(
        { table, tables: new Map([["g", table]]), readable: () => true },
        { limit: 10 },
      ).text;
      expect(sql).toContain(`r."SHAPE".STAsText() as "shape"`);
    });

    it("reads a MySQL bit as binary text and a geometry as its text", () => {
      const table: EngineTable = {
        id: "m",
        storage: "external",
        physicalName: "x_m",
        external: {
          sourceId: "s",
          dialect: "mysql",
          schema: "sales",
          name: "flags",
          key: ["id"],
        },
        columns: [
          {
            id: "m1",
            name: "flags",
            label: "Flags",
            fieldType: "text",
            config: {},
            physical: { name: "flags", type: "bit(4)", zone: "UTC" },
          },
          {
            id: "m2",
            name: "place",
            label: "Place",
            fieldType: "text",
            config: {},
            physical: { name: "place", type: "point", zone: "UTC" },
          },
        ],
      };
      const sql = buildReadRows(
        { table, tables: new Map([["m", table]]), readable: () => true },
        { limit: 10 },
      ).text;
      expect(sql).toContain(`lpad(bin(r."flags"), 4, '0') as "flags"`);
      expect(sql).toContain(`st_astext(r."place") as "place"`);
    });

    it("sums SQL Server's whole numbers and money as decimals", () => {
      for (const type of ["int", "bigint", "smallint", "tinyint", "money"]) {
        const sql = buildAggregates(numberColumn("sqlserver", type), {}, [
          { column: "amount", fn: "sum" },
          { column: "amount", fn: "avg" },
        ]).text;
        expect(sql).toContain(`sum(cast(q."amount" as decimal(38,10)))`);
        expect(sql).toContain(`avg(cast(q."amount" as decimal(38,10)))`);
      }
      const exact = buildAggregates(
        numberColumn("sqlserver", "decimal(12,2)"),
        {},
        [{ column: "amount", fn: "sum" }],
      ).text;
      expect(exact).toContain(`sum(q."amount")`);
    });

    it("leaves a figure empty when a value no decimal holds is in it", () => {
      for (const [dialect, type] of [
        ["sqlserver", "float"],
        ["oracle", "binary_double"],
      ] as const) {
        const catalog = numberColumn(dialect, type);
        const sum = buildAggregates(catalog, {}, [
          { column: "amount", fn: "sum" },
        ]).text;
        expect(sum).toMatch(/case when count\(q\."ag_e\d+"\) = 0 then sum\(/);
        const grouped = buildGroupAggregates(
          catalog,
          {},
          { groups: ["amount"], item: { column: "amount", fn: "max" } },
        ).text;
        expect(grouped).toMatch(
          /case when count\(q\."ag_e\d+"\) = 0 then max\(/,
        );
        const empties = buildAggregates(catalog, {}, [
          { column: "amount", fn: "count_empty" },
        ]).text;
        expect(empties).toMatch(/q\."amount" is null and q\."ag_e\d+" is null/);
        expect(empties).not.toContain(`count(q."ag_e`);
      }
    });

    it("compares a value past a decimal by what is stored", () => {
      const filter = {
        conjunction: "and" as const,
        conditions: [{ column: "amount", op: "gt" as const, value: "100" }],
      };
      const sqlServer = buildReadRows(numberColumn("sqlserver", "float"), {
        limit: 5,
        filter,
      }).text;
      expect(sqlServer).toMatch(/where \(\(q\."ag_n\d+" >/);
      const oracle = buildReadRows(numberColumn("oracle", "binary_double"), {
        limit: 5,
        filter,
      }).text;
      expect(oracle).toContain(`r."AMOUNT" is not nan`);
      const exact = buildReadRows(numberColumn("sqlserver", "decimal(12,2)"), {
        limit: 5,
        filter,
      }).text;
      expect(exact).not.toContain("ag_n");
    });

    it("guards no figure of a type every read holds", () => {
      const sql = buildAggregates(
        numberColumn("sqlserver", "decimal(12,2)"),
        {},
        [
          { column: "amount", fn: "sum" },
          { column: "amount", fn: "count_empty" },
        ],
      ).text;
      expect(sql).not.toContain("ag_e");
    });

    it("says the same of a formula that gives one, and not of its length", () => {
      const catalog = numberColumn("oracle", "clob");
      const [stored] = catalog.table.columns;
      if (!stored) throw new Error("no column");
      stored.fieldType = "long_text";
      const formula = (name: string, expr: FormulaExpr) => ({
        id: name,
        name,
        label: name,
        fieldType: "formula" as const,
        config: { expr },
      });
      const notes: FormulaExpr = { op: "col", name: "amount" };
      const table: EngineTable = {
        ...catalog.table,
        columns: [
          ...catalog.table.columns,
          formula("as_is", notes),
          formula("again", { op: "col", name: "as_is" }),
          formula("size", { op: "call", fn: "len", args: [notes] }),
          formula("picked", {
            op: "call",
            fn: "switch",
            args: [notes, { op: "str", value: "a" }, { op: "str", value: "b" }],
          }),
        ],
      };
      const withFormulas: EngineCatalog = {
        ...catalog,
        table,
        tables: new Map([[table.id, table]]),
      };
      const fields = new Map(
        describeColumns(withFormulas).map((field) => [field.name, field]),
      );
      expect(fields.get("as_is")?.noCompare).toBe(true);
      expect(fields.get("again")?.noCompare).toBe(true);
      expect(fields.get("size")?.noCompare).toBeUndefined();
      expect(fields.get("picked")?.noCompare).toBeUndefined();
    });

    it("makes a short text a large one beside it, and compares them", () => {
      const catalog = numberColumn("oracle", "clob");
      const [stored] = catalog.table.columns;
      if (!stored) throw new Error("no column");
      stored.fieldType = "long_text";
      const notes: FormulaExpr = { op: "col", name: "amount" };
      const of = (expr: FormulaExpr): EngineCatalog => {
        const table: EngineTable = {
          ...catalog.table,
          columns: [
            ...catalog.table.columns,
            {
              id: "f",
              name: "f",
              label: "f",
              fieldType: "formula",
              config: { expr },
            },
          ],
        };
        return { ...catalog, table, tables: new Map([[table.id, table]]) };
      };
      const chosen = buildReadRows(
        of({
          op: "if",
          cond: { op: "bool", value: true },
          then: notes,
          else: { op: "str", value: "none" },
        }),
        { limit: 5 },
      ).text;
      expect(chosen).toContain("to_clob(");
      const same = buildReadRows(
        of({ op: "eq", left: notes, right: { op: "str", value: "a" } }),
        { limit: 5 },
      ).text;
      expect(same).toContain("dbms_lob.compare(");
    });

    it("compares no large object on Oracle, and says so of the field", () => {
      const catalog = numberColumn("oracle", "clob");
      const [column] = catalog.table.columns;
      if (column) column.fieldType = "long_text";
      expect(describeColumns(catalog)[0]).toMatchObject({
        noCompare: true,
        noGroup: true,
      });
      const refused = { code: "not_comparable" };
      expect(() =>
        buildReadRows(catalog, {
          limit: 5,
          sort: [{ column: "amount", direction: "asc" }],
        }),
      ).toThrow(expect.objectContaining(refused));
      expect(() =>
        buildReadRows(catalog, {
          limit: 5,
          filter: {
            conjunction: "and",
            conditions: [{ column: "amount", op: "is", value: "a" }],
          },
        }),
      ).toThrow(expect.objectContaining(refused));
      expect(() =>
        buildAggregates(catalog, {}, [
          { column: "amount", fn: "count_unique" },
        ]),
      ).toThrow(expect.objectContaining(refused));
      // A pattern reads it, and so does a count of what is filled.
      expect(
        buildReadRows(catalog, {
          limit: 5,
          filter: {
            conjunction: "and",
            conditions: [{ column: "amount", op: "contains", value: "a" }],
          },
        }).text,
      ).toContain("like");
      expect(() =>
        buildAggregates(catalog, {}, [
          { column: "amount", fn: "count_filled" },
        ]),
      ).not.toThrow();
      expect(
        aggregatesOfField({ kind: "text", noCompare: true }),
      ).not.toContain("count_unique");
      expect(aggregatesOfField({ kind: "text" })).toContain("count_unique");
    });

    it("reads what Oracle and SQL Server show as text, as text", () => {
      const read = (dialect: "oracle" | "sqlserver", type: string) =>
        buildReadRows(numberColumn(dialect, type), { limit: 5 }).text;
      expect(read("oracle", "raw(8)")).toContain(`rawtohex(r."AMOUNT")`);
      expect(read("oracle", "blob")).toContain("dbms_lob.substr");
      expect(read("oracle", "interval day(2) to second(6)")).toContain(
        `to_char(r."AMOUNT")`,
      );
      expect(read("oracle", "boolean")).toContain(
        `case when r."AMOUNT" then 1 when not r."AMOUNT" then 0 end`,
      );
      expect(read("sqlserver", "xml")).toContain("as nvarchar(max))");
      expect(read("sqlserver", "hierarchyid")).toContain(".ToString()");
      expect(read("sqlserver", "uniqueidentifier")).toContain("as char(36))");
      expect(read("sqlserver", "sql_variant")).toContain("as nvarchar(4000))");
      expect(read("sqlserver", "rowversion")).toContain("varchar(18)");
      expect(read("sqlserver", "time(7)")).toContain("as varchar(16))");
    });
  });
});
