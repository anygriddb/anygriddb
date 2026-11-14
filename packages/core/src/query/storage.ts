/**
 * What depends on where a table's rows live (ADR 0002): a table of
 * AnyGridDB, with its uuid ids and system columns, or a table or view of a
 * client's database, named by its own key and with none of them. The rest
 * of the read engine asks here, and is the same for both.
 */
import { AppError } from "../errors";
import {
  isWritableType,
  physicalSqlType,
  storedValueKind,
} from "../field-types";
import { dialectOf, POSTGRES, type SqlDialect } from "./dialect";
import type { EngineColumn, EngineTable } from "./engine";
import { quoteExternalIdent, quoteIdent } from "./params";

/**
 * The database a table's rows are read in: a client's, for a table read
 * live, or AnyGridDB's own, for its tables and the copies of synced ones.
 */
export function storeOf(table: EngineTable): string {
  return table.external && !table.external.synced
    ? `source:${table.external.sourceId}`
    : "anygriddb";
}

/** The table in a FROM clause. */
export function tableSql(table: EngineTable): string {
  return table.external
    ? `${quoteExternalIdent(table.external.schema)}.${quoteExternalIdent(table.external.name)}`
    : quoteIdent(table.physicalName);
}

/**
 * The table a read selects from. With fields AnyGridDB added (ADR 0032),
 * the client's table joined to its side table on the key: the client's
 * columns AnyGridDB reads, then the side's, under their own names, so every
 * other part of a read sees one table. A row without side values reads
 * them as null.
 */
export function readTableSql(table: EngineTable): string {
  const external = table.external;
  const sideColumns = table.columns.flatMap((column) =>
    column.physical?.side ? [column.physical.name] : [],
  );
  if (
    !external?.side ||
    sideColumns.length === 0 ||
    external.key.length === 0
  ) {
    return tableSql(table);
  }
  const own = new Set(external.key);
  for (const column of table.columns) {
    // A field kept in AnyGridDB's database is in neither table (ADR 0046).
    if (
      column.physical &&
      !column.physical.side &&
      !column.physical.missing &&
      !column.physical.controlPlane
    ) {
      own.add(column.physical.name);
    }
  }
  const select = [
    ...[...own].map((name) => `t.${quoteExternalIdent(name)}`),
    ...sideColumns.map((name) => `s.${quoteExternalIdent(name)}`),
  ];
  const on = external.key
    .map(
      (name) => `s.${quoteExternalIdent(name)} = t.${quoteExternalIdent(name)}`,
    )
    .join(" and ");
  return `(select ${select.join(", ")} from ${tableSql(table)} t left join ${quoteExternalIdent(external.side.schema)}.${quoteExternalIdent(external.side.name)} s on ${on})`;
}

/** A column as its table stores it, in its field's SQL type. */
export function columnSql(
  alias: string,
  column: Pick<EngineColumn, "name" | "physical" | "fieldType">,
  dialect: SqlDialect = POSTGRES,
): string {
  if (column.physical === undefined)
    return `${alias}.${quoteIdent(column.name)}`;
  // A field added since a synced table's last refresh (ADR 0034), or a
  // control-plane enrichment field merged after the client read (ADR 0046).
  if (column.physical.missing || column.physical.controlPlane) {
    if (dialect.name !== "postgres") {
      // In the client's engine: a typed null in its own syntax.
      const kind = isWritableType(column.fieldType)
        ? storedValueKind(column.fieldType)
        : "text";
      return dialect.nullOf(
        kind === "number" ||
          kind === "boolean" ||
          kind === "date" ||
          kind === "datetime"
          ? kind
          : "text",
      );
    }
    return isWritableType(column.fieldType)
      ? `null::${physicalSqlType(column.fieldType)}`
      : "null::text";
  }
  return dialect.readColumn(
    `${alias}.${quoteExternalIdent(column.physical.name)}`,
    column.fieldType,
    column.physical,
  );
}

/** A column of `table` by its stored name, such as a foreign key. */
export function storedColumnSql(
  table: EngineTable,
  alias: string,
  name: string,
): string {
  return table.external
    ? `${alias}.${quoteExternalIdent(name)}`
    : `${alias}.${quoteIdent(name)}`;
}

/** What links join on: AnyGridDB's uuid, or a client table's one-column key. */
export function keySql(table: EngineTable, alias: string): string {
  if (!table.external) return `${alias}."id"`;
  const [key, ...more] = table.external.key;
  if (key === undefined || more.length > 0) {
    throw new AppError("invalid_relation");
  }
  return `${alias}.${quoteExternalIdent(key)}`;
}

/**
 * The id a client sees for a row: AnyGridDB's uuid, or a client table's key
 * as text (several key columns as a JSON array). A view without a key
 * names a row by its content.
 */
export function idSql(table: EngineTable, alias: string): string {
  if (!table.external) return `${alias}."id"`;
  // A copy keeps the id the client's table gave each row (ADR 0034).
  if (table.external.synced) return `${alias}."ag_id"`;
  const dialect = dialectOf(table);
  const key = table.external.key;
  if (key.length > 0) {
    return dialect.keyId(
      key.map((name) => `${alias}.${quoteExternalIdent(name)}`),
    );
  }
  return dialect.contentId(
    alias,
    table.columns.flatMap((column) =>
      column.physical
        ? [`${alias}.${quoteExternalIdent(column.physical.name)}`]
        : [],
    ),
  );
}

/** Expressions that put rows in the same order every time. */
export function stableOrderSql(table: EngineTable, alias: string): string[] {
  if (!table.external) return [`${alias}."ag_seq"`];
  const key = table.external.key;
  return key.length > 0
    ? key.map((name) => `${alias}.${quoteExternalIdent(name)}`)
    : [idSql(table, alias)];
}

type SystemField =
  | "ag_status"
  | "ag_seq"
  | "ag_created_at"
  | "ag_updated_at"
  | "ag_created_by"
  | "ag_updated_by";

const EXTERNAL_SYSTEM: Record<SystemField, string> = {
  ag_status: "null::text",
  ag_seq: "null::bigint",
  ag_created_at: "null::timestamptz",
  ag_updated_at: "null::timestamptz",
  ag_created_by: "null::uuid",
  ag_updated_by: "null::uuid",
};

/** A system column, or null on a client's table, which has none. */
export function systemSql(
  table: EngineTable,
  alias: string,
  field: SystemField,
): string {
  if (!table.external) return `${alias}."${field}"`;
  return dialectOf(table).name === "postgres" ? EXTERNAL_SYSTEM[field] : "null";
}
