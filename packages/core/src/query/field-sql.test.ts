import { describe, expect, it } from "vitest";
import { FIELD_TYPES, isWritableType } from "../field-types";
import { MYSQL, POSTGRES } from "./dialect";
import { ORACLE } from "./dialect-oracle";
import {
  FIELD_SQL,
  formulaExprOf,
  holdsOf,
  readSqlType,
  rollupFnOf,
  SIDE_FIELD_TYPES,
} from "./field-sql";

const column = (type: string) => ({ name: "c", type, zone: "UTC" });

describe("the SQL of each field type, from its entry", () => {
  it("gives every type a read, and a column held only where one is stored", () => {
    for (const type of FIELD_TYPES) {
      const entry = FIELD_SQL[type];
      expect(entry.read, type).toBeTruthy();
      if (entry.writesToClient) expect(entry.holds, type).not.toBeNull();
      if (entry.side) expect(isWritableType(type), type).toBe(true);
    }
    expect(SIDE_FIELD_TYPES).toContain("text");
    expect(SIDE_FIELD_TYPES).not.toContain("duration");
  });

  it("reads a number of any kind on a float without its infinities", () => {
    for (const type of ["number", "rating", "duration"] as const) {
      expect(
        POSTGRES.readColumn('q."c"', type, column("real")),
        type,
      ).toContain("'Infinity'::float8");
    }
    expect(POSTGRES.readColumn('q."c"', "text", column("text"))).toBe('q."c"');
  });

  it("reads a document as its text, a day as its day, a flag as a truth", () => {
    expect(holdsOf("json")).toBe("document");
    expect(readSqlType("json")).toBe("text");
    expect(readSqlType("number")).toBe("numeric");
    expect(readSqlType("formula")).toBe("text");
    expect(MYSQL.readColumn("`c`", "single_select", column("longtext"))).toBe(
      "cast(`c` as char)",
    );
    expect(MYSQL.readColumn("`c`", "boolean", column("tinyint(1)"))).toBe(
      "(`c` <> 0)",
    );
    expect(ORACLE.readColumn('"c"', "date", column("date"))).toBe('trunc("c")');
    expect(ORACLE.readColumn('"c"', "text", column("varchar2(10)"))).toBe(
      '"c"',
    );
  });

  it("reads a formula's expression and a rollup's function, nothing of another type", () => {
    const expr = { op: "str", value: "x" } as const;
    expect(formulaExprOf({ fieldType: "formula", config: { expr } })).toBe(
      expr,
    );
    expect(
      formulaExprOf({ fieldType: "text", config: { expr } }),
    ).toBeUndefined();
    expect(rollupFnOf({ fieldType: "rollup", config: { fn: "sum" } })).toBe(
      "sum",
    );
    expect(
      rollupFnOf({ fieldType: "lookup", config: { fn: "sum" } }),
    ).toBeUndefined();
  });
});
