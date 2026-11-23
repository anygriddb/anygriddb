import { describe, expect, it } from "vitest";
import { MYSQL, POSTGRES } from "./dialect";
import { ORACLE } from "./dialect-oracle";
import { SQLSERVER } from "./dialect-sqlserver";
import type { PhysicalColumn } from "./engine";

const physical = (type: string): PhysicalColumn => ({
  name: "c",
  type,
  zone: "UTC",
});

describe("what a client column is read as", () => {
  it("reads SQL Server's money with its four decimals", () => {
    expect(SQLSERVER.readColumn("r.c", "number", physical("money"))).toBe(
      "cast(r.c as decimal(19,4))",
    );
    expect(SQLSERVER.readColumn("r.c", "number", physical("smallmoney"))).toBe(
      "cast(r.c as decimal(10,4))",
    );
  });

  it("reads a rowversion through binary(8), never as raw bytes", () => {
    for (const type of ["timestamp", "rowversion"]) {
      expect(SQLSERVER.readColumn("r.c", "text", physical(type))).toContain(
        "cast(r.c as binary(8))",
      );
    }
  });

  it("writes a float's output from the stored value", () => {
    expect(SQLSERVER.floatOutput?.("r.c", physical("float"))).toContain(
      "convert(varchar(32), r.c, 3)",
    );
    expect(ORACLE.floatOutput?.("r.c", physical("binary_double"))).toContain(
      "to_char(r.c)",
    );
    expect(SQLSERVER.floatOutput?.("r.c", physical("int"))).toBeUndefined();
  });

  it("says a float too small to write, rather than reading zero", () => {
    expect(
      SQLSERVER.storedError?.("r.c", physical("float"), "number"),
    ).toContain("1e-30");
  });

  it("reads PostgreSQL's floats through their exact text", () => {
    const read = POSTGRES.readColumn("r.c", "number", physical("real"));
    expect(read).toContain("(r.c)::text");
    expect(read).toContain("::numeric");
    expect(
      POSTGRES.readColumn("r.c", "number", physical("double precision")),
    ).toContain("(r.c)::text");
  });

  it("says a PostgreSQL float no number holds", () => {
    expect(
      POSTGRES.storedError?.("r.c", physical("double precision"), "number"),
    ).toContain("Infinity");
    expect(
      POSTGRES.storedError?.("r.c", physical("numeric(10,2)"), "number"),
    ).toBeUndefined();
  });

  it("reads MySQL's times and binaries as text", () => {
    expect(MYSQL.readColumn("r.c", "text", physical("time"))).toBe(
      "cast(r.c as char)",
    );
    for (const type of ["binary(4)", "varbinary(8)", "blob", "longblob"]) {
      expect(MYSQL.readColumn("r.c", "text", physical(type))).toBe(
        "concat('0x', hex(left(r.c, 1000)))",
      );
    }
  });

  it("reads MySQL's flag as checked whenever it is not zero", () => {
    expect(MYSQL.readColumn("r.c", "boolean", physical("tinyint(1)"))).toBe(
      "(r.c <> 0)",
    );
    expect(MYSQL.readColumn("r.c", "number", physical("tinyint(1)"))).toBe(
      "r.c",
    );
  });

  it("says an Oracle flag holding another code", () => {
    expect(
      ORACLE.storedError?.("r.c", physical("number(1)"), "boolean"),
    ).toContain("not in (0, 1)");
    expect(
      ORACLE.storedError?.("r.c", physical("number(1)"), "number"),
    ).toBeUndefined();
  });
});

describe("the first seal format's reading", () => {
  it("is what each engine read before", () => {
    expect(
      SQLSERVER.firstSeal?.readColumn("r.c", "number", physical("money")),
    ).toBe("r.c");
    expect(
      SQLSERVER.firstSeal?.readColumn("r.c", "text", physical("rowversion")),
    ).toBe("convert(varchar(18), r.c, 1)");
    expect(
      SQLSERVER.firstSeal?.readColumn("r.c", "number", physical("float")),
    ).toBe("(case when abs(r.c) < 1e28 then cast(r.c as decimal(38,10)) end)");
    expect(MYSQL.firstSeal?.readColumn("r.c", "text", physical("time"))).toBe(
      "r.c",
    );
    expect(MYSQL.firstSeal?.readColumn("r.c", "text", physical("blob"))).toBe(
      "r.c",
    );
    expect(
      POSTGRES.firstSeal?.readColumn("r.c", "number", physical("real")),
    ).toBe("(r.c)::numeric");
    expect(
      ORACLE.firstSeal?.readColumn("r.c", "number", physical("binary_double")),
    ).toBe("(case when abs(r.c) < 1e28 then cast(r.c as number(38,10)) end)");
  });
});
