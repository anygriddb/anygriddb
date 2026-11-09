import { describe, expect, it } from "vitest";
import { parseFormula } from "../formula";
import { compileFormula, toCharPattern, type ExprContext } from "./expressions";
import { catalogFor, orders } from "./fixtures.test-helpers";
import { MARIADB, MYSQL, POSTGRES, type SqlDialect } from "./dialect";
import { SQLSERVER } from "./dialect-sqlserver";
import type { EngineTable } from "./engine";
import { formulaLimits, type SourceLimit } from "./limits";
import { SqlParams } from "./params";

function compile(source: string, d: SqlDialect = POSTGRES) {
  const params = new SqlParams();
  const limits = new Map<string, SourceLimit>();
  const ctx: ExprContext = {
    catalog: catalogFor(),
    d,
    params,
    tz: "$0::text",
    aliases: { next: 0 },
    limits,
  };
  const refs = orders.columns.map((column) => ({
    name: column.name,
    label: column.label,
  }));
  const typed = compileFormula(
    ctx,
    orders,
    "r",
    parseFormula(source, refs),
    [],
  );
  return { typed, values: params.values, limits: [...limits.values()] };
}

/** A SQL Server table, its numbers typed as the source declares them. */
const ledger: EngineTable = {
  id: "l",
  storage: "external",
  physicalName: "x_l",
  external: {
    sourceId: "s",
    dialect: "sqlserver",
    schema: "dbo",
    name: "ledger",
    key: ["id"],
  },
  columns: [
    ["amount", "Amount", "decimal(14,2)"],
    ["qty", "Qty", "int"],
    ["wide", "Wide", "decimal(38,10)"],
  ].map(([name = "", label = "", type = ""]) => ({
    id: name,
    name,
    label,
    fieldType: "number" as const,
    config: {},
    physical: { name, type, zone: "UTC" },
  })),
};

function compileOn(d: SqlDialect, source: string) {
  const limits = new Map<string, SourceLimit>();
  const ctx: ExprContext = {
    catalog: {
      table: ledger,
      tables: new Map([[ledger.id, ledger]]),
      readable: () => true,
    },
    d,
    params: new SqlParams(),
    tz: "@p0",
    aliases: { next: 0 },
    limits,
  };
  const refs = ledger.columns.map(({ name, label }) => ({ name, label }));
  const typed = compileFormula(
    ctx,
    ledger,
    "r",
    parseFormula(source, refs),
    [],
  );
  return { typed, limits: [...limits.values()] };
}

describe("compileFormula", () => {
  it("types and guards arithmetic, text, logic, and dates", () => {
    // Division rounds to 20 decimals on every engine (ADR 0005).
    expect(compile("{Price} / {Qty}").typed).toEqual({
      sql: `round((r."price" + 0.00000000000000000000) / nullif(r."qty", 0), 20)`,
      kind: "number",
    });
    expect(compile('{Title} & " - " & {Status}').typed.kind).toBe("text");
    expect(compile("IF({Qty} > 2, 'big', BLANK())").typed.kind).toBe("text");
    expect(compile("IF({Qty} > 2, 1, 'x')").typed.kind).toBe("text");
    expect(compile("SQRT({Price})").typed.sql).toContain("case when");
    expect(compile("DATE_ADD({Due}, 3, 'days')").typed.kind).toBe("date");
    expect(compile("DATETIME_DIFF(TODAY(), {Due}, 'days')").typed.kind).toBe(
      "number",
    );
    expect(compile("{Client city}").typed).toMatchObject({
      kind: "array",
      elem: "text",
    });
    expect(compile("ARRAY_JOIN({Client}, '; ')").typed.kind).toBe("text");
    const formatted = compile("DATETIME_FORMAT({Due}, 'DD/MM/YYYY')");
    expect(formatted.values).toContain("DD/MM/YYYY");
  });

  it("runs what an engine computes differently, and says so", () => {
    expect(compile("SQRT({Price}) + 1").limits).toEqual([]);
    const mysql = compile("SQRT({Price}) + LOG({Qty}) * 2", MYSQL);
    expect(mysql.limits).toEqual([
      { code: "approximate", engine: "mysql", fn: "SQRT" },
      { code: "approximate", engine: "mysql", fn: "LOG" },
    ]);
    // Back to an exact decimal, to 15 significant digits.
    expect(mysql.typed.sql).toContain("decimal(65,30)");
    // MariaDB's derived tables cannot read the outer row: JSON_TABLE can.
    expect(compile("SQRT({Price})", MARIADB).typed.sql).toContain(
      "json_table(",
    );
    expect(compile("SQRT({Price})", MYSQL).typed.sql).not.toContain(
      "json_table(",
    );
  });

  it("finds an engine's limits where the formula writes them", () => {
    expect(formulaLimits("SQRT({a}) * 2", "postgres")).toEqual([]);
    expect(formulaLimits("sqrt({a}) * 2 / Power(2, 3)", "mariadb")).toEqual([
      { code: "approximate", engine: "mariadb", fn: "SQRT", from: 0, to: 4 },
      {
        code: "approximate",
        engine: "mariadb",
        fn: "POWER",
        from: 16,
        to: 21,
      },
    ]);
    // Precision depends on declared types: the server finds it.
    expect(formulaLimits("AVG({a}) / 2", "sqlserver")).toEqual([]);
    expect(formulaLimits("EXP({a})", "sqlserver")).toEqual([
      { code: "approximate", engine: "sqlserver", fn: "EXP", from: 0, to: 3 },
    ]);
  });

  it("follows SQL Server's decimals, and says where they round", () => {
    const amount = compileOn(SQLSERVER, "{Amount} / 3");
    // Widened to 20 decimals: T-SQL keeps 21 and the cast rounds.
    expect(amount.typed).toMatchObject({
      sql: 'cast(cast(r."amount" as decimal(32,20)) / nullif(cast(3 as decimal(1,0)), 0) as decimal(33,20))',
      digits: { p: 33, s: 20 },
    });
    expect(amount.limits).toEqual([]);
    expect(compileOn(SQLSERVER, "{Amount} * {Qty} + 1").limits).toEqual([]);
    expect(compileOn(SQLSERVER, "{Wide} * {Wide}").limits).toEqual([
      { code: "precision", engine: "sqlserver" },
    ]);
    expect(compileOn(SQLSERVER, "{Wide} / 7").limits).toEqual([
      { code: "precision", engine: "sqlserver" },
    ]);
    // Booleans are BIT values, conditions where T-SQL wants them.
    expect(compileOn(SQLSERVER, "{Qty} > 2").typed.sql).toBe(
      '(case when (r."qty" > cast(2 as decimal(1,0))) then cast(1 as bit) when not ((r."qty" > cast(2 as decimal(1,0)))) then cast(0 as bit) end)',
    );
  });

  it("refuses a formula whose SQL grows past its bound", () => {
    const nested = "SQRT(".repeat(30) + "{Price}" + ")".repeat(30);
    expect(() => compile(nested)).toThrow("Formula too large");
  });

  it("refuses dynamic units and patterns", () => {
    expect(() => compile("DATE_ADD({Due}, 1, {Title})")).toThrow(
      "Invalid formula",
    );
    expect(() => compile("DATE_ADD({Due}, 1, 'fortnight')")).toThrow(
      "Invalid unit",
    );
    expect(() => compile("DATETIME_FORMAT({Due}, {Title})")).toThrow(
      "Invalid formula",
    );
  });
});

describe("toCharPattern", () => {
  it("maps tokens and quotes literal text", () => {
    expect(toCharPattern("DD/MM/YYYY HH:mm")).toBe("DD/MM/YYYY HH24:MI");
    expect(toCharPattern('YYYY "Q" x')).toBe('YYYY "Q" "x"');
    expect(() => toCharPattern("")).toThrow("Invalid formula");
  });
});
