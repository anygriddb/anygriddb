import { describe, expect, it } from "vitest";
import {
  mapMysqlType,
  mapOracleType,
  mapPostgresType,
  mapSqlServerType,
  mysqlEnumValues,
} from "./source-types";

describe("PostgreSQL types", () => {
  it("maps the types AnyGridDB reads exactly to their fields", () => {
    expect(mapPostgresType({ type: "numeric(12,2)" })).toEqual({
      fieldType: "number",
      readOnly: false,
    });
    expect(mapPostgresType({ type: "bigint" }).fieldType).toBe("number");
    expect(mapPostgresType({ type: "character varying(80)" }).fieldType).toBe(
      "text",
    );
    expect(mapPostgresType({ type: "text" }).fieldType).toBe("long_text");
    expect(
      mapPostgresType({ type: "timestamp with time zone" }).fieldType,
    ).toBe("datetime");
    expect(
      mapPostgresType({ type: "status", enumValues: ["draft", "paid"] }),
    ).toEqual({
      fieldType: "single_select",
      readOnly: false,
      options: ["draft", "paid"],
    });
  });

  it("shows everything else as read-only text", () => {
    for (const type of [
      "jsonb",
      "integer[]",
      "geometry",
      "xml",
      "interval",
      "bytea",
    ]) {
      expect(mapPostgresType({ type }).readOnly, type).toBe(true);
    }
    expect(mapPostgresType({ type: "text[]", category: "A" })).toEqual({
      fieldType: "long_text",
      readOnly: true,
    });
  });
});

describe("MySQL and MariaDB columns", () => {
  it("maps their types to fields", () => {
    expect(mapMysqlType({ type: "tinyint(1)" }).fieldType).toBe("boolean");
    expect(mapMysqlType({ type: "tinyint(4)" }).fieldType).toBe("number");
    expect(mapMysqlType({ type: "bigint unsigned" }).fieldType).toBe("number");
    expect(mapMysqlType({ type: "decimal(14,2)" }).fieldType).toBe("number");
    expect(mapMysqlType({ type: "varchar(120)" }).fieldType).toBe("text");
    expect(mapMysqlType({ type: "mediumtext" }).fieldType).toBe("long_text");
    expect(mapMysqlType({ type: "datetime(3)" }).fieldType).toBe("datetime");
    expect(mapMysqlType({ type: "timestamp" }).fieldType).toBe("datetime");
    expect(mapMysqlType({ type: "date" }).fieldType).toBe("date");
  });

  it("reads an enumeration's labels, quotes and all", () => {
    expect(mysqlEnumValues("enum('draft','it''s','a,b')")).toEqual([
      "draft",
      "it's",
      "a,b",
    ]);
    expect(mapMysqlType({ type: "enum('draft','sent')" })).toEqual({
      fieldType: "single_select",
      readOnly: false,
      options: ["draft", "sent"],
    });
  });

  it("shows everything else as read-only text", () => {
    for (const type of [
      "json",
      "set('a','b')",
      "time",
      "bit(8)",
      "blob",
      "point",
    ]) {
      expect(mapMysqlType({ type }).readOnly, type).toBe(true);
    }
  });
});

describe("Oracle columns", () => {
  it("maps their types to fields", () => {
    expect(mapOracleType({ type: "NUMBER(1)" }).fieldType).toBe("boolean");
    expect(mapOracleType({ type: "NUMBER(14,2)" }).fieldType).toBe("number");
    expect(mapOracleType({ type: "VARCHAR2(120)" }).fieldType).toBe("text");
    expect(mapOracleType({ type: "CLOB" }).fieldType).toBe("long_text");
    expect(
      mapOracleType({ type: "TIMESTAMP(6) WITH TIME ZONE" }).fieldType,
    ).toBe("datetime");
    expect(mapOracleType({ type: "DATE" }).fieldType).toBe("date");
    expect(mapOracleType({ type: "BOOLEAN" }).fieldType).toBe("boolean");
    expect(mapOracleType({ type: "JSON" }).readOnly).toBe(true);
  });

  it("keeps binaries and intervals read-only", () => {
    expect(mapOracleType({ type: "BLOB" })).toEqual({
      fieldType: "text",
      readOnly: true,
    });
    expect(mapOracleType({ type: "RAW" }).readOnly).toBe(true);
    expect(
      mapOracleType({ type: "INTERVAL DAY(2) TO SECOND(6)" }).readOnly,
    ).toBe(true);
  });
});

describe("SQL Server columns", () => {
  it("maps their types to fields", () => {
    expect(mapSqlServerType({ type: "bit" }).fieldType).toBe("boolean");
    expect(mapSqlServerType({ type: "decimal(14,2)" }).fieldType).toBe(
      "number",
    );
    expect(mapSqlServerType({ type: "money" }).fieldType).toBe("number");
    expect(mapSqlServerType({ type: "nvarchar(120)" }).fieldType).toBe("text");
    expect(mapSqlServerType({ type: "nvarchar(max)" }).fieldType).toBe(
      "long_text",
    );
    expect(mapSqlServerType({ type: "datetime2(3)" }).fieldType).toBe(
      "datetime",
    );
    expect(mapSqlServerType({ type: "datetimeoffset(7)" }).fieldType).toBe(
      "datetime",
    );
    expect(mapSqlServerType({ type: "date" }).fieldType).toBe("date");
  });

  it("shows everything else as read-only text", () => {
    for (const type of [
      "uniqueidentifier",
      "time(7)",
      "varbinary(max)",
      "xml",
      "geography",
      "timestamp",
    ]) {
      expect(mapSqlServerType({ type }).readOnly, type).toBe(true);
    }
  });
});
