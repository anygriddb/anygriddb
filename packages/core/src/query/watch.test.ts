import { describe, expect, it } from "vitest";
import type { DialectName } from "./dialect";
import type { EngineTable } from "./engine";
import {
  buildChangeTracking,
  buildChangeVersion,
  buildWatchClock,
  buildWatchFuture,
  buildWatchPage,
  buildWatchStart,
  buildWatchWindow,
  watchKind,
} from "./watch";

function table(dialect: DialectName, key: string[]): EngineTable {
  return {
    id: "t",
    storage: "external",
    physicalName: "x_t",
    external: { sourceId: "s", dialect, schema: "app", name: "orders", key },
    columns: key.map((name) => ({
      id: name,
      name,
      label: name,
      fieldType: "number",
      config: {},
      physical: {
        name,
        type: dialect === "sqlserver" ? "int" : "integer",
        zone: "UTC",
      },
    })),
  };
}

describe("watchKind", () => {
  it("takes a date and time, or SQL Server's rowversion", () => {
    expect(watchKind("postgres", "timestamp with time zone")).toBe("time");
    expect(watchKind("postgres", "timestamp(3) without time zone")).toBe(
      "time",
    );
    expect(watchKind("postgres", "date")).toBeNull();
    expect(watchKind("mysql", "datetime(3)")).toBe("time");
    expect(watchKind("mariadb", "timestamp")).toBe("time");
    expect(watchKind("sqlserver", "datetime2(3)")).toBe("time");
    expect(watchKind("sqlserver", "rowversion")).toBe("version");
    expect(watchKind("sqlserver", "timestamp")).toBe("version");
    expect(watchKind("mysql", "int")).toBeNull();
  });
});

describe("a column that tells changes", () => {
  const at = { name: "updated_at", type: "timestamp with time zone" };

  it("starts at the column's highest value and the highest whole key", () => {
    expect(buildWatchStart(table("postgres", ["id"]), at).text).toBe(
      `select (max(t."updated_at"))::text as "m", (max(t."id"))::text as "top" from "app"."orders" t`,
    );
    // A rowversion stops short of the oldest open transaction's.
    expect(
      buildWatchStart(table("sqlserver", ["a", "b"]), {
        name: "rv",
        type: "rowversion",
      }).text,
    ).toBe(
      `select convert(varchar(18), cast(max(t."rv") as binary(8)), 1) as "m", null as "top" from "app"."orders" t where t."rv" < min_active_rowversion()`,
    );
  });

  it("reads the rows past a value, then past a key at that value", () => {
    const pg = buildWatchPage(
      table("postgres", ["id"]),
      at,
      { value: "2026-11-08 10:00:00+00", key: null },
      1000,
    );
    expect(pg).toEqual({
      text: `select (t."id")::text as "id", (t."updated_at")::text as "m", (t."id")::text as "k0" from "app"."orders" t where t."updated_at" > $1::timestamp with time zone order by t."updated_at", t."id" limit $2`,
      values: ["2026-11-08 10:00:00+00", 1000],
    });
    const ms = buildWatchPage(
      table("sqlserver", ["a", "b"]),
      { name: "changed", type: "datetime2(3)" },
      { value: "2026-11-08T10:00:00", key: ["1", "2"] },
      500,
    );
    expect(ms.text).toBe(
      `select (select t."a" as "k0", t."b" as "k1" for json path, without_array_wrapper, include_null_values) as "id", convert(varchar(40), t."changed", 126) as "m", cast(t."a" as nvarchar(1000)) as "k0", cast(t."b" as nvarchar(1000)) as "k1" from "app"."orders" t where (t."changed" > convert(datetime2(3), $1, 126) or (t."changed" = convert(datetime2(3), $2, 126) and ((t."a" > cast($3 as int)) or (t."a" = cast($3 as int) and t."b" > cast($4 as int))))) order by t."changed", t."a", t."b" offset 0 rows fetch next 500 rows only`,
    );
    expect(ms.values).toEqual([
      "2026-11-08T10:00:00",
      "2026-11-08T10:00:00",
      "1",
      "2",
    ]);
  });

  it("reads every row with a value when the table had none", () => {
    expect(
      buildWatchPage(
        table("mysql", ["id"]),
        { name: "updated_at", type: "datetime(3)" },
        null,
        10,
      ).text,
    ).toBe(
      `select cast(t."id" as char) as "id", cast(t."updated_at" as char) as "m", cast(t."id" as char) as "k0" from "app"."orders" t where t."updated_at" is not null order by t."updated_at", t."id" limit 10`,
    );
  });

  it("reads again a window behind, where late commits land", () => {
    const window = buildWatchWindow(
      table("mysql", ["id"]),
      { name: "updated_at", type: "datetime(3)" },
      "2026-11-08 10:00:00.000",
      120,
      2001,
    );
    expect(window).toEqual({
      text: `select cast(t."id" as char) as "id", cast(t."updated_at" as char) as "m" from "app"."orders" t where t."updated_at" > ($1 - interval 120 second) and t."updated_at" <= $2 order by t."updated_at", t."id" limit 2001`,
      values: ["2026-11-08 10:00:00.000", "2026-11-08 10:00:00.000"],
    });
    expect(() =>
      buildWatchWindow(
        table("sqlserver", ["id"]),
        { name: "rv", type: "rowversion" },
        "0x00",
        120,
        10,
      ),
    ).toThrow();
  });

  it("refuses a column that cannot tell changes, or an unsafe type", () => {
    expect(() =>
      buildWatchStart(table("postgres", ["id"]), { name: "d", type: "date" }),
    ).toThrow();
    expect(() =>
      buildWatchPage(
        table("postgres", ["id"]),
        { name: "d", type: "timestamp; drop table x" },
        { value: "x", key: null },
        10,
      ),
    ).toThrow();
  });
});

describe("SQL Server's Change Tracking", () => {
  it("reads the current version and the oldest kept", () => {
    expect(buildChangeVersion(table("sqlserver", ["id"])).values).toEqual([
      "app",
      "orders",
    ]);
    expect(() => buildChangeVersion(table("postgres", ["id"]))).toThrow();
  });

  it("reads the changes since a version, through a variable", () => {
    const changes = buildChangeTracking(
      table("sqlserver", ["id"]),
      "10",
      "42",
      { version: "12", key: ["7"] },
      1000,
    );
    expect(changes.text).toBe(
      `declare @ag_since bigint = cast($5 as bigint); select cast(ct."id" as nvarchar(1000)) as "id", ct.SYS_CHANGE_OPERATION as "op", cast(ct.SYS_CHANGE_VERSION as varchar(20)) as "v", cast(ct."id" as nvarchar(1000)) as "k0" from changetable(changes "app"."orders", @ag_since) ct where ct.SYS_CHANGE_VERSION <= cast($1 as bigint) and (ct.SYS_CHANGE_VERSION > cast($2 as bigint) or (ct.SYS_CHANGE_VERSION = cast($3 as bigint) and ((ct."id" > cast($4 as int))))) order by ct.SYS_CHANGE_VERSION, ct."id" offset 0 rows fetch next 1000 rows only`,
    );
    expect(changes.values).toEqual(["42", "12", "12", "7", "10"]);
  });
});

describe("a check bounded by the engine's clock", () => {
  const at = { name: "updated_at", type: "timestamp with time zone" };
  const clocks: Array<[DialectName, string, string]> = [
    ["postgres", "timestamp with time zone", "clock_timestamp()"],
    ["mysql", "datetime", "now(6)"],
    ["mariadb", "timestamp", "now(6)"],
    ["sqlserver", "datetime2(3)", "sysdatetime()"],
    ["sqlserver", "datetimeoffset(7)", "sysdatetimeoffset()"],
    ["oracle", "timestamp with time zone", "systimestamp"],
  ];

  it.each(clocks)("reads %s's own clock for a %s", (dialect, type, clock) => {
    const read = buildWatchClock(table(dialect, ["id"]), {
      name: "updated_at",
      type,
    });
    expect(read.text).toContain(clock);
    expect(read.text).toContain('as "clock"');
    expect(read.text).toContain('0 as "ahead"');
    expect(read.values).toEqual([]);
  });

  it("asks the engine whether a stored cursor is past its clock", () => {
    const read = buildWatchClock(
      table("postgres", ["id"]),
      at,
      "2099-01-01 00:00:00+00",
    );
    expect(read.text).toContain(
      "case when $1::timestamp with time zone > clock_timestamp()::timestamp with time zone then 1 else 0 end",
    );
    expect(read.values).toEqual(["2099-01-01 00:00:00+00"]);
  });

  it("casts SQL Server's clock to the column's precision", () => {
    expect(
      buildWatchClock(table("sqlserver", ["id"]), {
        name: "updated_at",
        type: "datetime",
      }).text,
    ).toContain("convert(varchar(40), cast(sysdatetime() as datetime), 126)");
  });

  it("refuses a column that tells no time", () => {
    expect(() =>
      buildWatchClock(table("sqlserver", ["id"]), {
        name: "v",
        type: "rowversion",
      }),
    ).toThrow();
    expect(() =>
      buildWatchFuture(
        table("sqlserver", ["id"]),
        { name: "v", type: "rowversion" },
        "0x00",
        10,
      ),
    ).toThrow();
  });

  it("starts from the highest value up to the clock, the key over all rows", () => {
    const start = buildWatchStart(table("postgres", ["id"]), at, "NOW");
    expect(start.text).toContain(
      'where t."updated_at" <= $1::timestamp with time zone',
    );
    expect(start.text).toContain('(select (max(k."id"))::text as "top" from');
    expect(start.values).toEqual(["NOW"]);
  });

  it("keeps a page at or before the clock", () => {
    const page = buildWatchPage(
      table("postgres", ["id"]),
      at,
      { value: "A", key: null },
      10,
      "NOW",
    );
    expect(page.text).toContain(
      't."updated_at" > $1::timestamp with time zone and t."updated_at" <= $2::timestamp with time zone',
    );
    expect(page.values).toEqual(["A", "NOW", 10]);
  });

  it("leaves a rowversion's page as it was", () => {
    const page = buildWatchPage(
      table("sqlserver", ["id"]),
      { name: "v", type: "rowversion" },
      { value: "0x01", key: null },
      10,
    );
    expect(page.text).not.toContain("sysdatetime");
  });

  it("reads the rows past the clock, in order, up to a limit", () => {
    const future = buildWatchFuture(table("postgres", ["id"]), at, "NOW", 2001);
    expect(future.text).toContain(
      'where t."updated_at" > $2::timestamp with time zone order by t."updated_at", t."id" limit $3',
    );
    expect(future.text).toContain(
      'case when t."updated_at" > ($1::timestamp with time zone + interval \'86400 seconds\') then 1 else 0 end as "far"',
    );
    expect(future.values).toEqual(["NOW", "NOW", 2001]);
  });
});
