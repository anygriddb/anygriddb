/**
 * What one look at a source reads. A list stops at `MAX_TABLES` and says so;
 * a search narrows it, and a table asked for by its name is read whatever
 * the list would have kept.
 */
import type { SourceTable, TableName, TableScope } from "./types.js";

/** Tables one list returns. */
const MAX_TABLES = 2_000;

/** One more than a list keeps: the extra row says it was cut. */
export const TABLES_READ = MAX_TABLES + 1;

/** The rows a list keeps, and whether there were more. */
export function cutTables<T>(rows: readonly T[]): {
  kept: T[];
  truncated: boolean;
} {
  return {
    kept: rows.slice(0, MAX_TABLES),
    truncated: rows.length > MAX_TABLES,
  };
}

/** For a store whose tables are filtered once listed. */
export function inScope(table: TableName, scope: TableScope = {}): boolean {
  if (
    scope.only &&
    !scope.only.some(
      (item) => item.schema === table.schema && item.name === table.name,
    )
  ) {
    return false;
  }
  return (
    scope.search === undefined ||
    `${table.schema}.${table.name}`
      .toLowerCase()
      .includes(scope.search.toLowerCase())
  );
}

/** Only the tables named, spelled exactly: a catalog may compare without case. */
export function exactly(
  tables: readonly SourceTable[],
  names: readonly TableName[],
): SourceTable[] {
  const wanted = new Set(names.map((item) => `${item.schema}\0${item.name}`));
  return tables.filter((table) => wanted.has(`${table.schema}\0${table.name}`));
}
