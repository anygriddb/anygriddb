import { describe, expect, it } from "vitest";
import type { DialectName } from "./dialect";
import type { EngineColumn, EngineTable } from "./engine";
import {
  buildExternalDelete,
  buildExternalInsert,
  buildExternalLock,
  buildExternalUpdate,
  buildInsertedId,
  keyValues,
  sameCell,
  type StoredColumn,
} from "./external-write";

function column(
  name: string,
  fieldType: EngineColumn["fieldType"],
  type: string,
  zone = "UTC",
): StoredColumn {
  return {
    id: name,
    name,
    label: name,
    fieldType,
    config: {},
    physical: { name, type, zone },
  };
}

function table(
  dialect: DialectName,
  key: string[],
  columns: StoredColumn[],
): EngineTable {
  return {
    id: "t",
    storage: "external",
    physicalName: "x_t",
    external: { sourceId: "s", dialect, schema: "app", name: "lines", key },
    columns,
  };
}

const id = column("id", "number", "integer");

describe("keyValues", () => {
  it("reads one key column as the id itself", () => {
    expect(keyValues(table("postgres", ["id"], [id]), "1001")).toEqual([
      "1001",
    ]);
  });

  it("reads several as JSON, keeping a bigint's digits", () => {
    const pg = table("postgres", ["a", "b"], []);
    expect(keyValues(pg, '[9007199254740993, "A-\\"7"]')).toEqual([
      "9007199254740993",
      'A-"7',
    ]);
    const ms = table("sqlserver", ["a", "b"], []);
    expect(keyValues(ms, '{"k1":"x","k0":12.50}')).toEqual(["12.50", "x"]);
  });

  it("refuses an id that names no row", () => {
    const pg = table("postgres", ["a", "b"], []);
    for (const bad of ["[1]", "[1, 2, 3]", "[1, null]", "1, 2", "[1, 2] x", ""])
      expect(() => keyValues(pg, bad), bad).toThrow();
    expect(() => keyValues(table("postgres", [], []), "x")).toThrow(
      /primary key/,
    );
  });
});

describe("external statements", () => {
  it("locks rows by key, SQL Server with an update lock", () => {
    expect(
      buildExternalLock(table("postgres", ["id"], [id]), ["1", "2"]),
    ).toEqual({
      text: `select 1 as "locked" from "app"."lines" where "id" in ($1, $2) for update`,
      values: ["1", "2"],
    });
    const code = column("code", "text", "varchar(20)");
    expect(
      buildExternalLock(table("sqlserver", ["code"], [code]), ["A"]).text,
    ).toBe(
      `select 1 as "locked" from "app"."lines" with (updlock, holdlock, rowlock) where "code" in (cast($1 as varchar(20)))`,
    );
    expect(
      buildExternalLock(table("mysql", ["a", "b"], []), ["[1, 2]"]).text,
    ).toBe(
      `select 1 as "locked" from "app"."lines" where ("a" = $1 and "b" = $2) for update`,
    );
  });

  it("writes each type as the engine stores it", () => {
    const amount = column("amount", "number", "numeric(14,2)");
    const paid = column("paid", "boolean", "boolean");
    const at = column(
      "at",
      "datetime",
      "timestamp without time zone",
      "Europe/Paris",
    );
    const pg = table("postgres", ["id"], [id, amount, paid, at]);
    expect(
      buildExternalUpdate(pg, "7", [
        { column: amount, value: "12.50" },
        { column: paid, value: true },
        { column: at, value: "2026-11-08T10:00:00.000Z" },
      ]),
    ).toEqual({
      text: `update "app"."lines" set "amount" = $1, "paid" = $2, "at" = ($3::timestamptz at time zone 'Europe/Paris') where "id" = $4`,
      values: ["12.50", "true", "2026-11-08 10:00:00.000Z", "7"],
    });

    const myAt = column("at", "datetime", "datetime", "Europe/Paris");
    const myPaid = column("paid", "boolean", "tinyint(1)");
    const my = table("mysql", ["id"], [id, myAt, myPaid]);
    expect(
      buildExternalUpdate(my, "7", [
        { column: myAt, value: "2026-11-08T10:00:00Z" },
        { column: myPaid, value: false },
      ]),
    ).toEqual({
      text: `update "app"."lines" set "at" = convert_tz($1, '+00:00', 'Europe/Paris'), "paid" = $2 where "id" = $3`,
      values: ["2026-11-08 10:00:00", 0, "7"],
    });

    const msAt = column("at", "datetime", "datetime2(7)", "Europe/Paris");
    const ms = table("sqlserver", ["id"], [id, msAt]);
    expect(
      buildExternalUpdate(ms, "7", [
        { column: msAt, value: "2026-11-08T10:00:00Z" },
      ]).text,
    ).toBe(
      `update "app"."lines" set "at" = cast(cast($1 as datetimeoffset) at time zone 'Romance Standard Time' as datetime2(7)) where "id" = cast($2 as integer)`,
    );
  });

  it("refuses a fraction in a whole-number column", () => {
    const qty = column("qty", "number", "int");
    expect(() =>
      buildExternalUpdate(table("mysql", ["id"], [id, qty]), "1", [
        { column: qty, value: "1.5" },
      ]),
    ).toThrow(/does not fit/);
    expect(
      buildExternalUpdate(table("mysql", ["id"], [id, qty]), "1", [
        { column: qty, value: "2.00" },
      ]).values,
    ).toEqual(["2.00", "1"]);
  });

  it("adds a row and reads its key back", () => {
    const name = column("name", "text", "text");
    const pg = table("postgres", ["id"], [id, name]);
    expect(buildExternalInsert(pg, [{ column: name, value: "A" }])).toEqual({
      text: `insert into "app"."lines" ("name") values ($1) returning ("id")::text as "id"`,
      values: ["A"],
    });
    expect(buildExternalInsert(pg, []).text).toBe(
      `insert into "app"."lines" default values returning ("id")::text as "id"`,
    );
    const ms = table(
      "sqlserver",
      ["id"],
      [column("id", "number", "int"), name],
    );
    expect(buildExternalInsert(ms, [{ column: name, value: "A" }]).text).toBe(
      `declare @ag table ("k0" int); insert into "app"."lines" ("name") output inserted."id" into @ag values ($1); select cast(a."k0" as nvarchar(1000)) as "id" from @ag a`,
    );
    // MySQL and MariaDB have no DEFAULT VALUES.
    expect(
      buildExternalInsert(table("mysql", ["id"], [id, name]), []).text,
    ).toBe(`insert into "app"."lines" () values ()`);
    const my = table("mariadb", ["id"], [id, name]);
    expect(buildInsertedId(my, [{ column: name, value: "A" }])?.text).toBe(
      `select cast(t."id" as char) as "id" from "app"."lines" t where t."id" = last_insert_id()`,
    );
    expect(buildInsertedId(my, [{ column: id, value: "5" }])).toEqual({
      text: `select cast(t."id" as char) as "id" from "app"."lines" t where t."id" = $1`,
      values: ["5"],
    });
    expect(buildInsertedId(table("mysql", ["a", "b"], []), [])).toBeNull();
  });

  it("deletes by key", () => {
    expect(
      buildExternalDelete(table("postgres", ["a", "b"], []), "[1, 2]"),
    ).toEqual({
      text: `delete from "app"."lines" where "a" = $1 and "b" = $2`,
      values: ["1", "2"],
    });
  });
});

describe("sameCell", () => {
  it("compares numbers by value and the rest exactly", () => {
    expect(sameCell("12.50", "12.5")).toBe(true);
    expect(sameCell("-0.0", "0")).toBe(true);
    expect(sameCell(3, "3.0")).toBe(true);
    expect(sameCell("12.5", "12.51")).toBe(false);
    expect(sameCell("a", "a ")).toBe(false);
    expect(sameCell(null, undefined)).toBe(true);
    expect(sameCell(null, "")).toBe(false);
    expect(sameCell(true, true)).toBe(true);
  });
});
