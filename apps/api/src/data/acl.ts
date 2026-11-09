import {
  effectiveTableRole,
  filterGroupSchema,
  type Binding,
  type ColumnAccess,
  type ColumnAclEntry,
  type EngineAccess,
  type EngineCatalog,
  type FilterGroup,
  type TableAcl,
} from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { readableTables } from "../trpc/guard.js";
import { withAudit } from "./audit-context.js";
import { loadEngine, type CatalogRows } from "./engine.js";

export type LoadedAcl = {
  rowFilter: FilterGroup | null;
  columns: ColumnAclEntry[];
  /** True when at least one ACL row exists for this person on the table. */
  configured: boolean;
};

export async function loadTableAcl(
  db: Database,
  tableId: string,
  userId: string,
): Promise<LoadedAcl> {
  const row = await db
    .selectFrom("tableAcls")
    .selectAll()
    .where("tableId", "=", tableId)
    .where("userId", "=", userId)
    .executeTakeFirst();
  const columns = await db
    .selectFrom("columnAcls")
    .select(["columnName as column", "access"])
    .where("tableId", "=", tableId)
    .where("userId", "=", userId)
    .execute();
  const parsed = row?.rowFilter
    ? filterGroupSchema.safeParse(row.rowFilter)
    : null;
  return {
    rowFilter: parsed?.success ? parsed.data : null,
    columns: columns.map((item) => ({
      column: item.column,
      access: item.access,
    })),
    configured: Boolean(row) || columns.length > 0,
  };
}

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
export type Reader = { userId: string; bindings: readonly Binding[] };

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
  const [rowRules, columnRules] = await Promise.all([
    db
      .selectFrom("tableAcls")
      .select(["tableId", "rowFilter"])
      .where("userId", "=", reader.userId)
      .where("tableId", "in", restricted)
      .execute(),
    db
      .selectFrom("columnAcls")
      .select(["tableId", "columnName as column", "access"])
      .where("userId", "=", reader.userId)
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
    me: reader.userId,
  };
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
