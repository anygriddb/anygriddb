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
});
