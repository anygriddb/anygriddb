import { describe, expect, it } from "vitest";
import { sourcesOf } from "./sources";

const table = (
  id: string,
  source: { id: string; name: string } | null,
  engine = "postgres",
) => ({
  id,
  name: `Table ${id}`,
  external: { engine, schema: "public", name: `t_${id}`, source },
});

describe("sourcesOf", () => {
  it("groups the tables of every base under the database they live in", () => {
    const erp = { id: "s1", name: "ERP" };
    const crm = { id: "s2", name: "CRM" };
    const groups = sourcesOf([
      { id: "b1", name: "Sales", tables: [table("a", erp), table("b", crm)] },
      { id: "b2", name: "Finance", tables: [table("c", erp, "postgres")] },
    ]);
    expect(groups.map((group) => [group.name, group.tables.length])).toEqual([
      ["CRM", 1],
      ["ERP", 2],
    ]);
    expect(groups[1]?.tables[1]).toEqual({
      baseId: "b2",
      baseName: "Finance",
      tableId: "c",
      name: "Table c",
      stored: "public.t_c",
    });
  });

  it("leaves out AnyGridDB's own tables and tables without a source", () => {
    expect(
      sourcesOf([
        {
          id: "b1",
          name: "Notes",
          tables: [{ id: "n", name: "Own", external: null }, table("x", null)],
        },
      ]),
    ).toEqual([]);
  });
});
