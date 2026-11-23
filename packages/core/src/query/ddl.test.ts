import { describe, expect, it } from "vitest";
import {
  buildAddColumn,
  buildCreateJunction,
  buildCreateTable,
  buildFileIndex,
  buildForeignKeyIndex,
  indexName,
} from "./ddl";

describe("what changes a table's structure", () => {
  it("asks the owner for a table, with its stored fields only", () => {
    const statements = buildCreateTable({
      table: "t_orders",
      columns: [
        { name: "title", fieldType: "text" },
        { name: "tags", fieldType: "multi_select" },
        { name: "total", fieldType: "formula" },
      ],
    });
    expect(statements).toHaveLength(1);
    expect(statements[0]?.text).toBe(
      "select ag_create_table($1::text, $2::text)",
    );
    expect(statements[0]?.values[0]).toBe("t_orders");
    expect(JSON.parse(String(statements[0]?.values[1]))).toEqual([
      { name: "title", fieldType: "text" },
      { name: "tags", fieldType: "multi_select" },
    ]);
  });

  it("binds a default, and refuses reserved or computed columns", () => {
    const added = buildAddColumn({
      table: "t_x",
      column: { name: "note", fieldType: "text" },
      defaultValue: "a'b",
    });
    expect(added.text).toBe(
      "select ag_add_column($1::text, $2::text, $3::text, $4::text)",
    );
    expect(added.values).toEqual(["t_x", "note", "text", "a'b"]);
    expect(
      buildAddColumn({
        table: "t_x",
        column: { name: "note", fieldType: "text" },
      }).values[3],
    ).toBeNull();
    expect(() =>
      buildAddColumn({
        table: "t_x",
        column: { name: "ag_x", fieldType: "text" },
      }),
    ).toThrow("Duplicate column");
    expect(() =>
      buildAddColumn({
        table: "t_x",
        column: { name: "f", fieldType: "formula" },
      }),
    ).toThrow("Invalid column");
    expect(() =>
      buildAddColumn({
        table: "t_x",
        column: { name: "note", fieldType: "text" },
        defaultValue: "a\u0000",
      }),
    ).toThrow("Invalid default");
  });

  it("asks the owner for a junction, and refuses a bad name", () => {
    const statements = buildCreateJunction({
      junction: "j_links",
      leftTable: "t_left",
      rightTable: "t_right",
    });
    expect(statements).toHaveLength(1);
    expect(statements[0]?.values).toEqual(["j_links", "t_left", "t_right"]);
    expect(() =>
      buildCreateJunction({
        junction: "Bad-Name",
        leftTable: "t_left",
        rightTable: "t_right",
      }),
    ).toThrow("Invalid table name");
  });

  it("indexes a link's foreign key column", () => {
    const table = "t_0123456789abcdef0123456789abcdef";
    expect(buildForeignKeyIndex({ table, column: "project" }).values).toEqual([
      table,
      "project",
    ]);
    // The name the database computes too (`ag_index_name`).
    expect(indexName(table, "project", "ix")).toBe(
      "ix_0123456789abcdef_f4bd82be",
    );
    expect(() => buildForeignKeyIndex({ table, column: "ag_seq" })).toThrow();
    expect(() =>
      buildForeignKeyIndex({ table: "Bad-Name", column: "project" }),
    ).toThrow("Invalid table name");
  });

  it("keeps a concurrent index a statement: no function can run one", () => {
    expect(
      buildFileIndex({ table: "t_x", column: "files", concurrently: true })
        .text,
    ).toContain("create index concurrently if not exists");
    expect(buildFileIndex({ table: "t_x", column: "files" }).text).toBe(
      "select ag_create_file_index($1::text, $2::text)",
    );
  });
});
