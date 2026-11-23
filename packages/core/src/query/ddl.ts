import {
  isWritableType,
  physicalSqlType,
  type FieldType,
} from "../field-types";
import { isReservedColumnName } from "../names";
import { assertIdentifier, quoteIdent, type ParameterizedSql } from "./params";
import { AppError } from "../errors";

/**
 * What changes the structure of a table. The application asks a function
 * of the tables' owner (ADR 0119), with names and field types as bound
 * values; the function checks them again. Every name is checked here too,
 * so that a bad one is refused with the error the caller can show.
 */

function statement(text: string): ParameterizedSql {
  return { text, values: [] };
}

/** A call to one of the owner's functions, each argument bound as text. */
export function ownerCall(
  name: string,
  ...args: ReadonlyArray<string | null>
): ParameterizedSql {
  const list = args.map((_, index) => `$${index + 1}::text`).join(", ");
  return { text: `select ${name}(${list})`, values: [...args] };
}

/** A column's default as the owner's function takes it. Rejects NUL. */
function defaultText(value: string | number | boolean): string {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new AppError("invalid_default");
  }
  if (typeof value === "string" && value.includes("\u0000")) {
    throw new AppError("invalid_default");
  }
  return String(value);
}

function fnv(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** Short deterministic index name for a table column. */
export function indexName(
  table: string,
  column: string,
  kind: "uq" | "ix" | "gin",
): string {
  return `${kind}_${table.slice(2, 18)}_${fnv(column)}`;
}

type DdlColumn = { name: string; fieldType: FieldType };

export function assertUserColumn(name: string): void {
  assertIdentifier(name, "column name");
  if (isReservedColumnName(name)) {
    throw new AppError("duplicate_column");
  }
}

/**
 * Creates a physical table: identity, status, system columns, the stored
 * user columns, the sequence and order indexes, and both triggers.
 */
export function buildCreateTable(input: {
  table: string;
  columns: readonly DdlColumn[];
}): ParameterizedSql[] {
  assertIdentifier(input.table, "table name");
  if (input.columns.length > 200) {
    throw new AppError("invalid_column_count");
  }
  const seen = new Set<string>();
  const stored: DdlColumn[] = [];
  for (const column of input.columns) {
    assertUserColumn(column.name);
    if (seen.has(column.name)) {
      throw new AppError("duplicate_column");
    }
    seen.add(column.name);
    if (isWritableType(column.fieldType)) {
      stored.push({ name: column.name, fieldType: column.fieldType });
    }
  }
  return [ownerCall("ag_create_table", input.table, JSON.stringify(stored))];
}

export function buildAddColumn(input: {
  table: string;
  column: DdlColumn;
  defaultValue?: string | number | boolean;
}): ParameterizedSql {
  assertIdentifier(input.table, "table name");
  assertUserColumn(input.column.name);
  if (!isWritableType(input.column.fieldType)) {
    throw new AppError("invalid_column");
  }
  return ownerCall(
    "ag_add_column",
    input.table,
    input.column.name,
    input.column.fieldType,
    input.defaultValue === undefined ? null : defaultText(input.defaultValue),
  );
}

export function buildSetDefault(input: {
  table: string;
  column: DdlColumn;
  defaultValue: string | number | boolean | null;
}): ParameterizedSql {
  assertIdentifier(input.table, "table name");
  assertUserColumn(input.column.name);
  if (input.defaultValue !== null) physicalSqlType(input.column.fieldType);
  return ownerCall(
    "ag_set_column_default",
    input.table,
    input.column.name,
    input.column.fieldType,
    input.defaultValue === null ? null : defaultText(input.defaultValue),
  );
}

export function buildDropColumn(input: {
  table: string;
  column: string;
}): ParameterizedSql {
  assertIdentifier(input.table, "table name");
  assertIdentifier(input.column, "column name");
  return ownerCall("ag_drop_column", input.table, input.column);
}
export function buildDropTable(table: string): ParameterizedSql {
  assertIdentifier(table, "table name");
  return ownerCall("ag_drop_table", table);
}

export function buildUniqueIndex(input: {
  table: string;
  column: string;
}): ParameterizedSql {
  assertIdentifier(input.table, "table name");
  assertUserColumn(input.column);
  return ownerCall("ag_create_unique_index", input.table, input.column);
}

export function buildDropUniqueIndex(input: {
  table: string;
  column: string;
}): ParameterizedSql {
  assertIdentifier(input.table, "table name");
  assertIdentifier(input.column, "column name");
  return ownerCall("ag_drop_unique_index", input.table, input.column);
}

/** Adds a nullable foreign key. The target table must already exist. */
export function buildAddForeignKeyColumn(input: {
  table: string;
  column: string;
  targetTable: string;
}): ParameterizedSql {
  assertIdentifier(input.table, "table name");
  assertUserColumn(input.column);
  assertIdentifier(input.targetTable, "table name");
  return ownerCall(
    "ag_add_link_column",
    input.table,
    input.column,
    input.targetTable,
  );
}

/**
 * The index of a foreign key column. PostgreSQL makes none of its own: the
 * other side of the link reads the rows that point to each of its rows, and
 * deleting a row clears the ones that pointed to it; without the index both
 * read the whole table.
 */
export function buildForeignKeyIndex(input: {
  table: string;
  column: string;
}): ParameterizedSql {
  assertIdentifier(input.table, "table name");
  assertUserColumn(input.column);
  return ownerCall("ag_create_link_index", input.table, input.column);
}

/**
 * The index that finds the rows holding a file, so that serving one never
 * reads the whole table. `concurrently` builds it beside the writes, for a
 * table that already has rows; it cannot run inside a transaction, so not
 * inside a function either: it stays a statement.
 */
export function buildFileIndex(input: {
  table: string;
  column: string;
  concurrently?: boolean;
}): ParameterizedSql {
  assertIdentifier(input.table, "table name");
  assertUserColumn(input.column);
  if (!input.concurrently) {
    return ownerCall("ag_create_file_index", input.table, input.column);
  }
  return statement(
    `create index concurrently if not exists ${quoteIdent(indexName(input.table, input.column, "gin"))} on ${quoteIdent(input.table)} using gin (${quoteIdent(input.column)})`,
  );
}

/** Removes an index a build left unfinished, without blocking the table. */
export function buildDropIndexConcurrently(name: string): ParameterizedSql {
  assertIdentifier(name, "identifier");
  return statement(`drop index concurrently if exists ${quoteIdent(name)}`);
}

/** The whole-column GIN indexes of a table, and whether each is usable. */
export function buildFileIndexStates(table: string): ParameterizedSql {
  assertIdentifier(table, "table name");
  return {
    text: `select a.attname as "column", c.relname as "name", x.indisvalid as "valid" from pg_index x join pg_class c on c.oid = x.indexrelid join pg_am m on m.oid = c.relam join pg_attribute a on a.attrelid = x.indrelid and a.attnum = x.indkey[0] where x.indrelid = to_regclass($1) and m.amname = 'gin' and x.indnatts = 1 and x.indpred is null`,
    values: [quoteIdent(table)],
  };
}

/**
 * Many-to-many junction of row ids, both sides cascading when a row is
 * removed: its primary key covers left→right lookups, a second index on
 * `right_id` the inverse scans of link columns that point the other way.
 */
export function buildCreateJunction(input: {
  junction: string;
  leftTable: string;
  rightTable: string;
}): ParameterizedSql[] {
  assertIdentifier(input.junction, "table name");
  assertIdentifier(input.leftTable, "table name");
  assertIdentifier(input.rightTable, "table name");
  return [
    ownerCall(
      "ag_create_junction",
      input.junction,
      input.leftTable,
      input.rightTable,
    ),
  ];
}
