import { describe, expect, it } from "vitest";
import type { DialectName } from "./dialect";
import type { EngineColumn, EngineTable } from "./engine";
import {
  buildSideColumn,
  buildSideDelete,
  buildSideEnsure,
  buildSideLock,
  buildSideTable,
  buildSideUpsert,
  sideColumnType,
  type StoredColumn,
} from "./external-write";
import { readTableSql } from "./storage";

function column(
  name: string,
  fieldType: EngineColumn["fieldType"],
  type: string,
  side = false,
): StoredColumn {
  return {
    id: name,
    name,
    label: name,
    fieldType,
    config: {},
    physical: { name, type, zone: "UTC", ...(side ? { side: true } : {}) },
  };
}

function table(dialect: DialectName, columns: StoredColumn[]): EngineTable {
  return {
    id: "t",
    storage: "external",
    physicalName: "x_t",
    external: {
      sourceId: "s",
      dialect,
      schema: "erp",
      name: "customers",
      key: ["id"],
      side: { schema: "ag_side", name: "ag_t_1" },
    },
    columns,
  };
}

const id = column("id", "number", "int");
const name = column("name", "text", "varchar(100)");
const status = column("ag_status", "single_select", "varchar(200)", true);

describe("side tables", () => {
  it("reads the client's table joined to its side table", () => {
    expect(readTableSql(table("postgres", [id, name, status]))).toBe(
      `(select t."id", t."name", s."ag_status" from "erp"."customers" t left join "ag_side"."ag_t_1" s on s."id" = t."id")`,
    );
    // Without a side field, the client's table alone.
    expect(readTableSql(table("postgres", [id, name]))).toBe(
      `"erp"."customers"`,
    );
  });

  it("creates the side table keyed like the client's, then a column", () => {
    const pg = table("postgres", [id, name]);
    expect(buildSideTable(pg).text).toBe(
      `create table "ag_side"."ag_t_1" ("id" int not null, primary key ("id"))`,
    );
    expect(buildSideColumn(pg, "ag_status", "single_select").text).toBe(
      `alter table "ag_side"."ag_t_1" add column "ag_status" text null`,
    );
    expect(
      buildSideColumn(table("sqlserver", [id]), "ag_n", "number").text,
    ).toBe(`alter table "ag_side"."ag_t_1" add "ag_n" decimal(38,10) null`);
    expect(sideColumnType("mysql", "datetime")).toBe("datetime(6)");
  });

  it("writes a row's side values, adding its side row if it has none", () => {
    const values = [{ column: status, value: "Actif" }];
    expect(
      buildSideUpsert(table("postgres", [id, status]), "7", values),
    ).toEqual({
      text: `insert into "ag_side"."ag_t_1" ("id", "ag_status") values ($1, $2) on conflict ("id") do update set "ag_status" = excluded."ag_status"`,
      values: ["7", "Actif"],
    });
    expect(
      buildSideUpsert(table("mariadb", [id, status]), "7", values).text,
    ).toBe(
      `insert into "ag_side"."ag_t_1" ("id", "ag_status") values ($1, $2) on duplicate key update "ag_status" = values("ag_status")`,
    );
    expect(
      buildSideUpsert(table("sqlserver", [id, status]), "7", values).text,
    ).toBe(
      `update "ag_side"."ag_t_1" set "ag_status" = $2 where "id" = cast($1 as int); if @@rowcount = 0 insert into "ag_side"."ag_t_1" ("id", "ag_status") values (cast($1 as int), $2)`,
    );
  });

  it("writes side email, url, phone, and rating", () => {
    const mail = column("ag_mail", "email", "text", true);
    const site = column("ag_url", "url", "text", true);
    const phone = column("ag_phone", "phone", "text", true);
    const rate = column("ag_rate", "rating", "integer", true);
    expect(
      buildSideUpsert(table("postgres", [id, mail, site, phone, rate]), "7", [
        { column: mail, value: "a@example.org" },
        { column: site, value: "https://example.com" },
        { column: phone, value: "+331" },
        { column: rate, value: 4 },
      ]),
    ).toEqual({
      text: `insert into "ag_side"."ag_t_1" ("id", "ag_mail", "ag_url", "ag_phone", "ag_rate") values ($1, $2, $3, $4, $5) on conflict ("id") do update set "ag_mail" = excluded."ag_mail", "ag_url" = excluded."ag_url", "ag_phone" = excluded."ag_phone", "ag_rate" = excluded."ag_rate"`,
      values: ["7", "a@example.org", "https://example.com", "+331", "4"],
    });
    const myRate = column("ag_rate", "rating", "int", true);
    expect(
      buildSideUpsert(table("mysql", [id, mail, myRate]), "7", [
        { column: mail, value: "a@example.org" },
        { column: myRate, value: 3 },
      ]).values,
    ).toEqual(["7", "a@example.org", "3"]);
    expect(() =>
      buildSideUpsert(table("postgres", [id, mail]), "7", [
        { column: mail, value: 1 },
      ]),
    ).toThrow(/Invalid cell/);
  });

  it("locks side rows, adding empty ones where the engine needs a row to lock", () => {
    expect(buildSideEnsure(table("postgres", [id]), ["1", "2"])).toEqual({
      text: `insert into "ag_side"."ag_t_1" ("id") values ($1), ($2) on conflict do nothing`,
      values: ["1", "2"],
    });
    expect(buildSideEnsure(table("mysql", [id]), ["1"])?.text).toBe(
      `insert ignore into "ag_side"."ag_t_1" ("id") values ($1)`,
    );
    expect(buildSideEnsure(table("sqlserver", [id]), ["1"])).toBeNull();
    expect(buildSideLock(table("sqlserver", [id]), ["1"]).text).toBe(
      `select 1 as "locked" from "ag_side"."ag_t_1" with (updlock, holdlock, rowlock) where "id" in (cast($1 as int))`,
    );
    expect(buildSideDelete(table("postgres", [id]), "1").text).toBe(
      `delete from "ag_side"."ag_t_1" where "id" = $1`,
    );
  });
});
