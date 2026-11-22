import { createHash } from "node:crypto";
import { rulesOwner } from "./acting-context.js";
import {
  effectiveTableRole,
  filterGroupSchema,
  roleAllows,
  type Binding,
  type ColumnAccess,
  type ColumnAclEntry,
  type EngineAccess,
  type EngineCatalog,
  type FilterGroup,
  type TableAcl,
} from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { withAudit } from "./audit-context.js";
import { liveColumnNames } from "./live.js";
import {
  assembleEngine,
  loadCatalogRows,
  loadEngine,
  type CatalogRows,
} from "./engine.js";

export async function listTableAcls(
  db: Database,
  tableId: string,
): Promise<TableAcl[]> {
  const rows = await db
    .selectFrom("tableAcls")
    .selectAll()
    .where("tableId", "=", tableId)
    .execute();
  const columns = await db
    .selectFrom("columnAcls")
    .selectAll()
    .where("tableId", "=", tableId)
    .execute();
  const byUser = new Map<string, ColumnAclEntry[]>();
  for (const column of columns) {
    const list = byUser.get(column.userId) ?? [];
    list.push({ column: column.columnName, access: column.access });
    byUser.set(column.userId, list);
  }
  const userIds = new Set([
    ...rows.map((row) => row.userId),
    ...columns.map((column) => column.userId),
  ]);
  return [...userIds].map((userId) => {
    const row = rows.find((item) => item.userId === userId);
    const parsed = row?.rowFilter
      ? filterGroupSchema.safeParse(row.rowFilter)
      : null;
    return {
      userId,
      rowFilter: parsed?.success ? parsed.data : null,
      columns: byUser.get(userId) ?? [],
    };
  });
}

/** Replaces one person's rules on a table, audited under the manager. */
export async function setTableAcl(
  db: Database,
  actorId: string,
  input: {
    tableId: string;
    userId: string;
    rowFilter: FilterGroup | null;
    columns: readonly ColumnAclEntry[];
  },
): Promise<void> {
  await withAudit(
    db,
    { userId: actorId, tableId: input.tableId, source: "web" },
    async (tx) => {
      await tx
        .deleteFrom("columnAcls")
        .where("tableId", "=", input.tableId)
        .where("userId", "=", input.userId)
        .execute();
      await tx
        .deleteFrom("tableAcls")
        .where("tableId", "=", input.tableId)
        .where("userId", "=", input.userId)
        .execute();
      if (input.rowFilter !== null || input.columns.length > 0) {
        await tx
          .insertInto("tableAcls")
          .values({
            tableId: input.tableId,
            userId: input.userId,
            rowFilter: input.rowFilter,
            updatedAt: new Date(),
          })
          .execute();
      }
      if (input.columns.length > 0) {
        await tx
          .insertInto("columnAcls")
          .values(
            input.columns.map((column) => ({
              tableId: input.tableId,
              userId: input.userId,
              columnName: column.column,
              access: column.access,
            })),
          )
          .execute();
      }
    },
  );
}

export async function clearTableAcl(
  db: Database,
  actorId: string,
  tableId: string,
  userId: string,
): Promise<void> {
  await setTableAcl(db, actorId, {
    tableId,
    userId,
    rowFilter: null,
    columns: [],
  });
}

/** Who reads: the account and its roles, which decide the rules that apply. */
type Reader = { userId: string; bindings: readonly Binding[] };

/** Which tables a reader may read: the engine hides the linked ones they may not. */
export function readableTables(
  bindings: readonly Binding[],
  baseOf: ReadonlyMap<string, string>,
): (tableId: string) => boolean {
  return (tableId) =>
    roleAllows(
      effectiveTableRole(bindings, tableId, baseOf.get(tableId)),
      "read",
    );
}

/**
 * The reader's field and row rules over `tables`, or undefined when none
 * applies. Owners of a table ignore its rules. With column rules on a table,
 * a field they do not name is hidden, so a field added later stays hidden
 * until a manager opens it.
 */
export async function readerAccess(
  db: Database,
  reader: Reader,
  tables: ReadonlyArray<{ id: string; baseId: string }>,
): Promise<EngineAccess | undefined> {
  const restricted = tables
    .filter(
      (table) =>
        effectiveTableRole(reader.bindings, table.id, table.baseId) !== "owner",
    )
    .map((table) => table.id);
  if (restricted.length === 0) return undefined;
  const owner = rulesOwner(reader.userId);
  const [rowRules, columnRules] = await Promise.all([
    db
      .selectFrom("tableAcls")
      .select(["tableId", "rowFilter"])
      .where("userId", "=", owner)
      .where("tableId", "in", restricted)
      .execute(),
    db
      .selectFrom("columnAcls")
      .select(["tableId", "columnName as column", "access"])
      .where("userId", "=", owner)
      .where("tableId", "in", restricted)
      .execute(),
  ]);
  if (rowRules.length === 0 && columnRules.length === 0) return undefined;
  const filters = new Map<string, FilterGroup>();
  for (const rule of rowRules) {
    if (!rule.rowFilter) continue;
    const parsed = filterGroupSchema.safeParse(rule.rowFilter);
    // A stored rule that no longer parses keeps no row rather than all.
    filters.set(
      rule.tableId,
      parsed.success ? parsed.data : { conjunction: "or", conditions: [] },
    );
  }
  const fields = new Map<string, Map<string, ColumnAccess>>();
  for (const rule of columnRules) {
    const map = fields.get(rule.tableId) ?? new Map<string, ColumnAccess>();
    map.set(rule.column, rule.access);
    fields.set(rule.tableId, map);
  }
  return {
    hidden: (tableId, column) => {
      const map = fields.get(tableId);
      return map !== undefined && (map.get(column) ?? "hide") === "hide";
    },
    readOnly: (tableId, column) => {
      const map = fields.get(tableId);
      return map !== undefined && map.get(column) === "read";
    },
    rowFilter: (tableId) => filters.get(tableId),
    me: owner,
  };
}

/**
 * A print of what a reader's rules leave them of a table and the tables it
 * links to, or null when no rule holds: two prints differ when a file
 * written under one may hold what the other hides. Which fields may be
 * written does not count, since a file only shows them.
 */
export async function readerRulesPrint(
  db: Database,
  reader: Reader,
  tableId: string,
): Promise<string | null> {
  const { tables: live } = await loadCatalogRows(db, [tableId]);
  // A table in the trash is out of the catalog and still under its rules.
  const tables =
    live.length > 0
      ? live
      : await db
          .selectFrom("dataTables")
          .select(["id", "baseId"])
          .where("id", "=", tableId)
          .execute();
  const roleOn = (table: { id: string; baseId: string }) =>
    effectiveTableRole(reader.bindings, table.id, table.baseId);
  const bound = tables.filter((table) => roleOn(table) !== "owner");
  if (bound.length === 0) return null;
  const ids = bound.map((table) => table.id);
  const owner = rulesOwner(reader.userId);
  const [rowRules, columnRules] = await Promise.all([
    db
      .selectFrom("tableAcls")
      .select(["tableId", "rowFilter"])
      .where("userId", "=", owner)
      .where("tableId", "in", ids)
      .execute(),
    db
      .selectFrom("columnAcls")
      .select(["tableId", "columnName as column", "access"])
      .where("userId", "=", owner)
      .where("tableId", "in", ids)
      .execute(),
  ]);
  const held = bound
    .map((table) => {
      const fields = columnRules.filter((rule) => rule.tableId === table.id);
      return {
        table: table.id,
        readable: roleAllows(roleOn(table), "read"),
        rows:
          rowRules.find((rule) => rule.tableId === table.id)?.rowFilter ?? null,
        fields:
          fields.length === 0
            ? null
            : fields
                .filter((rule) => rule.access !== "hide")
                .map((rule) => rule.column)
                .sort(),
      };
    })
    .filter((rule) => !rule.readable || rule.rows || rule.fields)
    .sort((a, b) => (a.table < b.table ? -1 : 1));
  if (held.length === 0) return null;
  return createHash("sha256").update(JSON.stringify(held)).digest("hex");
}

/**
 * The fields of a table hidden from this reader, by name: none for whoever
 * owns the table or has no rule on it.
 */
export async function hiddenColumnNames(
  db: Database,
  reader: Reader,
  table: { id: string; baseId: string },
): Promise<ReadonlySet<string>> {
  const access = await readerAccess(db, reader, [table]);
  if (!access) return new Set();
  const names = await liveColumnNames(db, table.id);
  return new Set([...names].filter((name) => access.hidden(table.id, name)));
}

/**
 * The read engine for one reader: tables they cannot read compile to
 * empty, and their field and row rules apply to every table it reads.
 * Every read on behalf of a person goes through here.
 */
export async function readerEngine(
  db: Database,
  tableId: string,
  reader: Reader,
): Promise<{ engine: EngineCatalog; rows: CatalogRows }> {
  const loaded = await loadEngine(db, tableId, () => true);
  const baseOf = new Map(
    loaded.rows.tables.map((table) => [table.id, table.baseId]),
  );
  const access = await readerAccess(db, reader, loaded.rows.tables);
  return {
    engine: {
      ...loaded.engine,
      readable: readableTables(reader.bindings, baseOf),
      ...(access ? { access } : {}),
    },
    rows: loaded.rows,
  };
}

/**
 * The read engines of several tables for one reader, from one read of the
 * catalog and of the reader's rules: what `readerEngine` gives for each
 * table, without the reads it makes for each. For a page that describes
 * many tables at once; a read of rows asks for its own table.
 */
export async function readerEngines(
  db: Database,
  tableIds: readonly string[],
  reader: Reader,
): Promise<{
  engineOf: (tableId: string) => EngineCatalog;
  rows: CatalogRows;
}> {
  const rows = await loadCatalogRows(db, tableIds);
  const baseOf = new Map(rows.tables.map((table) => [table.id, table.baseId]));
  const access = await readerAccess(db, reader, rows.tables);
  const readable = readableTables(reader.bindings, baseOf);
  return {
    engineOf: (tableId) => ({
      ...assembleEngine(tableId, rows, () => true),
      readable,
      ...(access ? { access } : {}),
    }),
    rows,
  };
}
