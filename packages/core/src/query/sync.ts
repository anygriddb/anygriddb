/**
 * Synced mode (ADRs 0006, 0034): a client's table copied into AnyGridDB's
 * own PostgreSQL, refreshed on a schedule, and read there.
 *
 * The copy holds what the read engine reads: each stored field in the SQL
 * type AnyGridDB gives that field, a link as the key it holds, the key
 * columns themselves, and `ag_id`, the id the client's table gives the
 * row, so a row keeps its id whichever way it is read. A refresh loads a
 * new copy beside the current one, compares the two, and swaps them in
 * one transaction; a read never sees half a copy.
 */
import { AppError } from "../errors";
import { isWritableType, physicalSqlType } from "../field-types";
import type { EngineTable } from "./engine";
import { quoteExternalIdent, type ParameterizedSql } from "./params";
import { sealedFields } from "./seal";

/** The schema of the copies, in AnyGridDB's database. */
export const SYNC_SCHEMA = "ag_sync";

/** Where a copy column's value comes from in a row the read engine read. */
type CopySource =
  | { kind: "id" }
  | { kind: "key"; index: number }
  | { kind: "field"; name: string; link: boolean };

export type CopyColumn = {
  /** As the client's table names it: the read engine reads it so. */
  name: string;
  /** Its PostgreSQL type in the copy. */
  type: string;
  source: CopySource;
};

const INTEGER =
  /^(?:tiny|small|medium|big)?int(?:eger)?(?:\(\d+\))?$|^int[248]$|^(?:big|small)?serial$/i;

/** A key or a foreign key: whole numbers stay numbers, so they sort as such. */
function keyType(declared: string | undefined): string {
  const type = (declared ?? "").trim().replace(/\s+unsigned$/i, "");
  return INTEGER.test(type) ? "bigint" : "text";
}

/**
 * The copy's columns for `table`, read live: `ag_id`, the key columns, then
 * each stored field once. `declared` gives a column's type in the client's
 * database, by its name there.
 */
export function copyColumns(
  table: EngineTable,
  declared: ReadonlyMap<string, string>,
): CopyColumn[] {
  const external = table.external;
  if (!external) throw new AppError("internal_error", "native table");
  const columns: CopyColumn[] = [
    { name: "ag_id", type: "text", source: { kind: "id" } },
  ];
  const taken = new Set(["ag_id"]);
  external.key.forEach((name, index) => {
    columns.push({
      name,
      type: keyType(declared.get(name)),
      source: { kind: "key", index },
    });
    taken.add(name);
  });
  for (const column of sealedFields(table)) {
    const physical = column.physical;
    if (!physical || taken.has(physical.name)) continue;
    taken.add(physical.name);
    const link = column.relation !== undefined;
    columns.push({
      name: physical.name,
      type: link
        ? keyType(declared.get(physical.name))
        : isWritableType(column.fieldType)
          ? physicalSqlType(column.fieldType)
          : "text",
      source: { kind: "field", name: column.name, link },
    });
  }
  return columns;
}

function copyName(tableId: string, next: boolean): string {
  if (!/^[0-9a-f-]{36}$/i.test(tableId)) {
    throw new AppError("internal_error", "table id");
  }
  return `${next ? "n" : "t"}_${tableId.replaceAll("-", "").toLowerCase()}`;
}

/** The copy a synced table reads, and the one a refresh loads. */
export function copyTable(tableId: string, next = false): string {
  return copyName(tableId, next);
}

function qualified(name: string): string {
  return `${quoteExternalIdent(SYNC_SCHEMA)}.${quoteExternalIdent(name)}`;
}

/** The statements that make an empty next copy, its indexes named after it. */
export function buildCopyCreate(
  tableId: string,
  columns: readonly CopyColumn[],
): ParameterizedSql[] {
  const name = copyTable(tableId, true);
  const list = columns
    .map((column) => `${quoteExternalIdent(column.name)} ${column.type}`)
    .join(", ");
  const keys = columns.filter((column) => column.source.kind === "key");
  const links = columns.filter(
    (column) => column.source.kind === "field" && column.source.link,
  );
  return [
    { text: `drop table if exists ${qualified(name)}`, values: [] },
    {
      text: `create table ${qualified(name)} (${list}, constraint ${quoteExternalIdent(`${name}_pkey`)} primary key ("ag_id"))`,
      values: [],
    },
    // Links join on the key and on foreign keys: both are indexed.
    ...(keys.length > 0
      ? [
          {
            text: `create index ${quoteExternalIdent(`${name}_k`)} on ${qualified(name)} (${keys.map((column) => quoteExternalIdent(column.name)).join(", ")})`,
            values: [],
          },
        ]
      : []),
    ...links.map((column, index) => ({
      text: `create index ${quoteExternalIdent(`${name}_f${String(index)}`)} on ${qualified(name)} (${quoteExternalIdent(column.name)})`,
      values: [],
    })),
  ];
}

/**
 * Adds rows, given as one JSON array of objects keyed by column name; a
 * row read twice while paging is kept once.
 */
export function buildCopyInsert(
  tableId: string,
  columns: readonly CopyColumn[],
  rows: ReadonlyArray<Readonly<Record<string, unknown>>>,
): ParameterizedSql {
  const names = columns
    .map((column) => quoteExternalIdent(column.name))
    .join(", ");
  const record = columns
    .map((column) => `${quoteExternalIdent(column.name)} ${column.type}`)
    .join(", ");
  return {
    text: `insert into ${qualified(copyTable(tableId, true))} (${names}) select ${names} from jsonb_to_recordset($1::jsonb) as r(${record}) on conflict ("ag_id") do nothing`,
    values: [JSON.stringify(rows)],
  };
}

/**
 * Upserts changed rows into the current copy (incremental refresh). Every
 * non-key column is replaced; `ag_id` is the conflict target.
 */
export function buildCopyUpsert(
  tableId: string,
  columns: readonly CopyColumn[],
  rows: ReadonlyArray<Readonly<Record<string, unknown>>>,
): ParameterizedSql {
  const names = columns
    .map((column) => quoteExternalIdent(column.name))
    .join(", ");
  const record = columns
    .map((column) => `${quoteExternalIdent(column.name)} ${column.type}`)
    .join(", ");
  const updates = columns
    .filter((column) => column.name !== "ag_id")
    .map(
      (column) =>
        `${quoteExternalIdent(column.name)} = excluded.${quoteExternalIdent(column.name)}`,
    )
    .join(", ");
  return {
    text: `insert into ${qualified(copyTable(tableId))} (${names}) select ${names} from jsonb_to_recordset($1::jsonb) as r(${record}) on conflict ("ag_id") do update set ${updates}`,
    values: [JSON.stringify(rows)],
  };
}

/** A link's cell as the key it holds. */
function linkKey(value: unknown): unknown {
  if (!Array.isArray(value)) return value ?? null;
  const [first] = value as unknown[];
  if (first && typeof first === "object" && "id" in first) {
    return first.id;
  }
  return first ?? null;
}

/** A row read live, as the copy stores it; `keys` from its id. */
export function copyRow(
  columns: readonly CopyColumn[],
  row: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const column of columns) {
    const source = column.source;
    out[column.name] =
      source.kind === "id"
        ? row.id
        : source.kind === "key"
          ? (keys[source.index] ?? null)
          : source.link
            ? linkKey(row[source.name])
            : (row[source.name] ?? null);
  }
  return out;
}

/**
 * The rows that differ between the current copy and the next, compared on
 * the columns both have: `op` is insert, update, or delete. At most
 * `limit` rows, and the count of each kind.
 */
export function buildCopyDiff(
  tableId: string,
  common: readonly string[],
  limit: number,
): ParameterizedSql {
  const pairs = (alias: string) =>
    `jsonb_build_object(${common.map((name) => `'${name.replaceAll("'", "''")}', ${alias}.${quoteExternalIdent(name)}`).join(", ")})`;
  const diff = `select coalesce(n."ag_id", o."ag_id") as "id", case when o."ag_id" is null then 'insert' when n."ag_id" is null then 'delete' else 'update' end as "op" from ${qualified(copyTable(tableId, true))} n full join ${qualified(copyTable(tableId))} o on o."ag_id" = n."ag_id" where o."ag_id" is null or n."ag_id" is null or ${pairs("n")} is distinct from ${pairs("o")}`;
  return {
    text: `select d."id", d."op", count(*) over (partition by d."op") as "count" from (${diff}) d limit ${String(Math.trunc(limit))}`,
    values: [],
  };
}

/** Makes the next copy the current one, indexes and all. */
export function buildCopySwap(
  tableId: string,
  columns: readonly CopyColumn[],
): ParameterizedSql[] {
  const next = copyTable(tableId, true);
  const current = copyTable(tableId);
  const links = columns.filter(
    (column) => column.source.kind === "field" && column.source.link,
  );
  const indexes = [
    "pkey",
    ...(columns.some((column) => column.source.kind === "key") ? ["k"] : []),
    ...links.map((_, index) => `f${String(index)}`),
  ];
  return [
    { text: `drop table if exists ${qualified(current)}`, values: [] },
    {
      text: `alter table ${qualified(next)} rename to ${quoteExternalIdent(current)}`,
      values: [],
    },
    ...indexes.map((suffix) => ({
      text: `alter index ${qualified(`${next}_${suffix}`)} rename to ${quoteExternalIdent(`${current}_${suffix}`)}`,
      values: [],
    })),
  ];
}

/** Removes a table's copies, when it leaves synced mode or AnyGridDB. */
export function buildCopyDrop(tableId: string): ParameterizedSql[] {
  return [
    {
      text: `drop table if exists ${qualified(copyTable(tableId, true))}`,
      values: [],
    },
    {
      text: `drop table if exists ${qualified(copyTable(tableId))}`,
      values: [],
    },
  ];
}
