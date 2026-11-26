/**
 * A base held in a SQL source (ADR 0090): the schema it owns there, and
 * the tables and columns AnyGridDB creates in it. Every name is the
 * product's: the schema is `ag` and part of the base's id, a table `t`
 * and random digits, a column the field's own name. A column takes the
 * type a side table gives its field (ADR 0032), so a value reads back
 * exactly as it was written.
 */
import { AppError } from "../errors";
import type { DialectName } from "./dialect";
import { sideColumnType, type SideFieldType } from "./field-sql";
import { quoteExternalIdent, type ParameterizedSql } from "./params";

/** The engines that can hold a base. Oracle's schema is its account. */
export type HomeDialect = Exclude<DialectName, "oracle">;

const HOME_DIALECTS: readonly string[] = [
  "postgres",
  "mysql",
  "mariadb",
  "sqlserver",
] satisfies readonly HomeDialect[];

export function isHomeDialect(name: string): name is HomeDialect {
  return HOME_DIALECTS.includes(name);
}

/**
 * A table of such a base, as the catalog names it in AnyGridDB's own
 * database, where nothing of it is stored.
 */
const HOME_TABLE_PREFIX = "h_";

export function homePhysicalName(random: string): string {
  if (!/^[0-9a-f]{32}$/.test(random)) throw new AppError("invalid_arguments");
  return `${HOME_TABLE_PREFIX}${random}`;
}

/** True for a table AnyGridDB created in the schema its base owns. */
export function isHomeTable(table: {
  storage: string;
  physicalName: string;
}): boolean {
  return (
    table.storage === "external" &&
    table.physicalName.startsWith(HOME_TABLE_PREFIX)
  );
}

const SCHEMA = /^ag[0-9a-f]{26}$/;
const TABLE = /^t[0-9a-f]{26}$/;
const COLUMN = /^[a-z_][a-z0-9_]{0,62}$/;

/** True for a schema name AnyGridDB mints, and for nothing else. */
export function isHomeSchemaName(name: string): boolean {
  return SCHEMA.test(name);
}

/** The schema of a base: stable, and short enough for every engine. */
export function homeSchemaName(baseId: string): string {
  return checked(SCHEMA, `ag${baseId.replaceAll("-", "").slice(0, 26)}`);
}

/** A new table's name in that schema: never the person's label. */
export function homeTableName(random: string): string {
  return checked(TABLE, `t${random.slice(0, 26)}`);
}

function checked(pattern: RegExp, name: string): string {
  if (!pattern.test(name)) throw new AppError("invalid_arguments");
  return name;
}

function tableSql(schema: string, table: string): string {
  return `${quoteExternalIdent(checked(SCHEMA, schema))}.${quoteExternalIdent(checked(TABLE, table))}`;
}

function columnSql(name: string): string {
  return quoteExternalIdent(checked(COLUMN, name));
}

/** Creates the schema. On MySQL and MariaDB, a schema is a database. */
export function buildCreateHome(
  dialect: HomeDialect,
  schema: string,
): ParameterizedSql {
  const name = checked(SCHEMA, schema);
  switch (dialect) {
    case "postgres":
      return { text: `create schema ${quoteExternalIdent(name)}`, values: [] };
    case "mysql":
    case "mariadb":
      return {
        text: `create database ${quoteExternalIdent(name)}`,
        values: [],
      };
    case "sqlserver":
      // CREATE SCHEMA must open its own batch.
      return {
        text: `exec(N'create schema ${quoteExternalIdent(name)}')`,
        values: [],
      };
  }
}

/**
 * Drops the schema and everything in it. Only an administrator who typed
 * its name gets here (ADR 0090).
 */
export function buildDropHome(
  dialect: HomeDialect,
  schema: string,
): ParameterizedSql {
  const name = checked(SCHEMA, schema);
  switch (dialect) {
    case "postgres":
      return {
        text: `drop schema if exists ${quoteExternalIdent(name)} cascade`,
        values: [],
      };
    case "mysql":
    case "mariadb":
      return {
        text: `drop database if exists ${quoteExternalIdent(name)}`,
        values: [],
      };
    case "sqlserver":
      // SQL Server drops a schema only once it is empty.
      return {
        text: [
          `declare @drop nvarchar(max) = N''`,
          `select @drop = @drop + N'drop table ' + quotename(s.name) + N'.' + quotename(t.name) + N';' from sys.tables t join sys.schemas s on s.schema_id = t.schema_id where s.name = N'${name}'`,
          `exec sp_executesql @drop`,
          `if schema_id(N'${name}') is not null drop schema ${quoteExternalIdent(name)}`,
        ].join("; "),
        values: [],
      };
  }
}

/** A column of a field that stores a value, typed as a side column is. */
export type HomeColumn = { name: string; fieldType: SideFieldType };

/**
 * A table in the base's schema: an identity `id`, which the grid shows
 * and nobody writes, then the fields that store a value.
 */
export function buildHomeTable(
  dialect: HomeDialect,
  schema: string,
  table: string,
  columns: readonly HomeColumn[],
): ParameterizedSql {
  const id =
    dialect === "mysql" || dialect === "mariadb"
      ? "bigint auto_increment primary key"
      : dialect === "sqlserver"
        ? "bigint identity primary key"
        : "bigint generated by default as identity primary key";
  const lines = [
    `${quoteExternalIdent("id")} ${id}`,
    ...columns.map(
      (column) =>
        `${columnSql(column.name)} ${sideColumnType(dialect, column.fieldType)} null`,
    ),
  ];
  return {
    text: `create table ${tableSql(schema, table)} (${lines.join(", ")})`,
    values: [],
  };
}

/** Drops one table this product created there. A missing one is not an error. */
export function buildDropHomeTable(
  schema: string,
  table: string,
): ParameterizedSql {
  return {
    text: `drop table if exists ${tableSql(schema, table)}`,
    values: [],
  };
}

/** A column added to a table this product created there. */
export function buildHomeColumn(
  dialect: HomeDialect,
  schema: string,
  table: string,
  column: HomeColumn,
): ParameterizedSql {
  const add = dialect === "sqlserver" ? "add" : "add column";
  return {
    text: `alter table ${tableSql(schema, table)} ${add} ${columnSql(column.name)} ${sideColumnType(dialect, column.fieldType)} null`,
    values: [],
  };
}

/**
 * Drops one such column. MySQL has no `if exists` for a column: ask
 * first with `buildHomeColumnExists`.
 */
export function buildDropHomeColumn(
  dialect: HomeDialect,
  schema: string,
  table: string,
  column: string,
): ParameterizedSql {
  const guard = dialect === "mysql" ? "" : "if exists ";
  return {
    text: `alter table ${tableSql(schema, table)} drop column ${guard}${columnSql(column)}`,
    values: [],
  };
}

/** One row when the column is there. */
export function buildHomeColumnExists(
  schema: string,
  table: string,
  column: string,
): ParameterizedSql {
  return {
    text: `select 1 as found from information_schema.columns where table_schema = $1 and table_name = $2 and column_name = $3`,
    values: [
      checked(SCHEMA, schema),
      checked(TABLE, table),
      checked(COLUMN, column),
    ],
  };
}

/** The SQL type of a field's column there, as the catalog records it. */
export function homeColumnType(
  dialect: HomeDialect,
  fieldType: SideFieldType,
): string {
  return sideColumnType(dialect, fieldType);
}
