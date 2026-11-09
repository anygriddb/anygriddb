import {
  AppError,
  describeColumns,
  purgeCutoff,
  purgeDate,
  restoredName,
  type TrashItem,
} from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { deleteFiles, type FileStore } from "../files/index.js";
import { withAudit } from "./audit-context.js";
import {
  assembleEngine,
  columnConfig,
  loadCatalogRows,
  type TableRow,
} from "./engine.js";
import { liveBase, liveColumn, liveTable } from "./live.js";
import {
  dependents,
  loadBaseRows,
  ownColumns,
  PRIMARY_TYPES,
  purgeColumn,
} from "./schema-ops.js";
import { removeBase, removeTable } from "./tables.js";
import type { ViewRow } from "./views.js";

/* ------------------------------------------------------------------ */
/* Moving to the trash                                                 */
/* ------------------------------------------------------------------ */

/** Hides a base and everything in it. Nothing is dropped until the purge. */
export async function trashBase(
  db: Database,
  userId: string,
  baseId: string,
): Promise<void> {
  const done = await db
    .updateTable("bases")
    .set({ deletedAt: new Date(), deletedBy: userId })
    .where("id", "=", baseId)
    .where(liveBase())
    .returning("id")
    .executeTakeFirst();
  if (!done) throw new AppError("no_row");
}

/**
 * Hides a table. Link fields of other tables that point to it go to the
 * trash with it, marked so that they come back with it; their lookups
 * read as empty meanwhile. Returns the tables whose fields changed.
 */
export async function trashTable(
  db: Database,
  userId: string,
  table: TableRow,
): Promise<{ affected: string[] }> {
  return withAudit(
    db,
    { userId, tableId: table.id, source: "web" },
    async (tx) => {
      const now = new Date();
      const done = await tx
        .updateTable("dataTables")
        .set({ deletedAt: now, deletedBy: userId })
        .where("id", "=", table.id)
        .where(liveTable())
        .returning("id")
        .executeTakeFirst();
      if (!done) throw new AppError("no_row");
      const hidden = await tx
        .updateTable("dataColumns")
        .set({ deletedAt: now, deletedBy: userId, deletedWith: table.id })
        .where("id", "in", (eb) =>
          eb
            .selectFrom("relations")
            .select("fromColumnId")
            .where("toTableId", "=", table.id),
        )
        .where("tableId", "<>", table.id)
        .where(liveColumn())
        .returning("tableId")
        .execute();
      return { affected: [...new Set(hidden.map((row) => row.tableId))] };
    },
  );
}

/**
 * Hides a field, and the other side of a two-way link with it. Refused
 * while a formula, lookup, or rollup still reads it, on either side.
 */
export async function trashColumn(
  db: Database,
  userId: string,
  table: TableRow,
  name: string,
): Promise<{ affected: string[] }> {
  const rows = await loadBaseRows(db, table.baseId);
  const own = ownColumns(rows, table.id);
  const column = own.find((item) => item.name === name);
  if (!column) {
    throw new AppError("unknown_column", name);
  }
  const relation = rows.relations.find(
    (item) => item.fromColumnId === column.id,
  );
  const config = columnConfig(column);
  const inverse =
    relation?.inverseColumnId && !config.inverseOf
      ? rows.columns.find((item) => item.id === relation.inverseColumnId)
      : undefined;
  const blocking = [
    ...dependents(rows, table.id, column),
    ...(inverse
      ? dependents(rows, inverse.tableId, inverse).filter(
          (item) => item.id !== column.id,
        )
      : []),
  ];
  if (blocking.length > 0) {
    throw new AppError(
      "column_in_use",
      blocking.map((item) => item.label).join(", "),
    );
  }
  await withAudit(
    db,
    { userId, tableId: table.id, source: "web" },
    async (tx) => {
      const now = new Date();
      await tx
        .updateTable("dataColumns")
        .set({ deletedAt: now, deletedBy: userId, isPrimary: false })
        .where("id", "=", column.id)
        .execute();
      if (inverse) {
        await tx
          .updateTable("dataColumns")
          .set({ deletedAt: now, deletedBy: userId, deletedWith: column.id })
          .where("id", "=", inverse.id)
          .where(liveColumn())
          .execute();
      }
      if (column.isPrimary) {
        const next = own.find(
          (item) => item.id !== column.id && PRIMARY_TYPES.has(item.fieldType),
        );
        if (next) {
          await tx
            .updateTable("dataColumns")
            .set({ isPrimary: true })
            .where("id", "=", next.id)
            .execute();
        }
      }
    },
  );
  return { affected: inverse ? [inverse.tableId] : [] };
}

/* ------------------------------------------------------------------ */
/* Restoring                                                           */
/* ------------------------------------------------------------------ */

async function liveLabels(db: Database, tableId: string): Promise<string[]> {
  const rows = await db
    .selectFrom("dataColumns")
    .select("label")
    .where("tableId", "=", tableId)
    .where(liveColumn())
    .execute();
  return rows.map((row) => row.label);
}

/** Brings back fields that went to the trash with `ownerId`, renaming clashes. */
async function restoreCompanions(
  db: Database,
  userId: string,
  ownerId: string,
): Promise<string[]> {
  const companions = await db
    .selectFrom("dataColumns")
    .selectAll()
    .where("deletedWith", "=", ownerId)
    .execute();
  for (const column of companions) {
    const label = restoredName(
      column.label,
      await liveLabels(db, column.tableId),
    );
    await withAudit(
      db,
      { userId, tableId: column.tableId, source: "restore" },
      (tx) =>
        tx
          .updateTable("dataColumns")
          .set({
            deletedAt: null,
            deletedBy: null,
            deletedWith: null,
            label,
          })
          .where("id", "=", column.id)
          .execute(),
    );
  }
  return [...new Set(companions.map((column) => column.tableId))];
}

export async function restoreBase(db: Database, baseId: string): Promise<void> {
  const done = await db
    .updateTable("bases")
    .set({ deletedAt: null, deletedBy: null })
    .where("id", "=", baseId)
    .where("deletedAt", "is not", null)
    .returning("id")
    .executeTakeFirst();
  if (!done) throw new AppError("no_row");
}

/** A table comes back with its name, or "Name (2)" when it was taken meanwhile. */
export async function restoreTable(
  db: Database,
  userId: string,
  tableId: string,
): Promise<{ baseId: string; affected: string[] }> {
  const table = await db
    .selectFrom("dataTables as t")
    .innerJoin("bases as b", "b.id", "t.baseId")
    .selectAll("t")
    .select("b.deletedAt as baseDeletedAt")
    .where("t.id", "=", tableId)
    .where("t.deletedAt", "is not", null)
    .executeTakeFirst();
  if (!table) throw new AppError("no_row");
  if (table.baseDeletedAt) throw new AppError("invalid_restore");
  const taken = await db
    .selectFrom("dataTables")
    .select("name")
    .where("baseId", "=", table.baseId)
    .where(liveTable())
    .execute();
  const name = restoredName(
    table.name,
    taken.map((item) => item.name),
  );
  await withAudit(db, { userId, tableId, source: "restore" }, (tx) =>
    tx
      .updateTable("dataTables")
      .set({ deletedAt: null, deletedBy: null, name })
      .where("id", "=", tableId)
      .execute(),
  );
  const affected = await restoreCompanions(db, userId, tableId);
  return { baseId: table.baseId, affected };
}

/**
 * A field comes back where it was. Refused while its table, or the table
 * its link points to, is in the trash, and when a formula, lookup, or
 * rollup would no longer compile, e.g. because a field it reads is gone.
 */
export async function restoreColumn(
  db: Database,
  userId: string,
  columnId: string,
): Promise<{ table: TableRow; affected: string[] }> {
  const column = await db
    .selectFrom("dataColumns")
    .selectAll()
    .where("id", "=", columnId)
    .where("deletedAt", "is not", null)
    .where("deletedWith", "is", null)
    .executeTakeFirst();
  if (!column) throw new AppError("no_row");
  const catalog = await loadCatalogRows(db, [column.tableId]);
  const table = catalog.tables.find((item) => item.id === column.tableId);
  if (!table) throw new AppError("invalid_restore");
  const relation = await db
    .selectFrom("relations")
    .selectAll()
    .where("fromColumnId", "=", column.id)
    .executeTakeFirst();
  if (relation && relation.toTableId !== table.id) {
    const target = await db
      .selectFrom("dataTables")
      .select("id")
      .where("id", "=", relation.toTableId)
      .where(liveTable())
      .executeTakeFirst();
    if (!target) throw new AppError("invalid_restore");
  }
  const label = restoredName(
    column.label,
    ownColumns(catalog, table.id).map((item) => item.label),
  );
  if (column.fieldType === "lookup" || column.fieldType === "rollup") {
    // A lookup without its link compiles to empty, so check what it reads.
    const config = columnConfig(column);
    const linkColumn = ownColumns(catalog, table.id).find(
      (item) => item.name === config.relation,
    );
    const linkRelation = linkColumn
      ? catalog.relations.find((item) => item.fromColumnId === linkColumn.id)
      : undefined;
    if (!linkColumn || !linkRelation) {
      throw new AppError("unknown_column", config.relation ?? "");
    }
    if (
      !catalog.columns.some(
        (item) =>
          item.tableId === linkRelation.toTableId &&
          item.name === config.target,
      )
    ) {
      throw new AppError("unknown_column", config.target ?? "");
    }
  }
  const restored = { ...column, label, deletedAt: null };
  const trial = {
    ...catalog,
    columns: [...catalog.columns, restored],
    relations: relation ? [...catalog.relations, relation] : catalog.relations,
  };
  if (
    column.fieldType === "formula" ||
    column.fieldType === "lookup" ||
    column.fieldType === "rollup"
  ) {
    const engine = assembleEngine(table.id, trial, () => true);
    const compiled = engine.table.columns.find((item) => item.id === column.id);
    if (!compiled) throw new AppError("invalid_restore");
    const described = describeColumns(engine).find(
      (item) => item.name === column.name,
    );
    if (described?.error) throw new Error(described.error);
  }
  await withAudit(db, { userId, tableId: table.id, source: "restore" }, (tx) =>
    tx
      .updateTable("dataColumns")
      .set({ deletedAt: null, deletedBy: null, label })
      .where("id", "=", column.id)
      .execute(),
  );
  const affected = await restoreCompanions(db, userId, column.id);
  return { table, affected };
}

/** A view comes back unless its table is in the trash. */
export async function restoreView(db: Database, view: ViewRow): Promise<void> {
  const table = await db
    .selectFrom("dataTables")
    .select("id")
    .where("id", "=", view.tableId)
    .where(liveTable())
    .executeTakeFirst();
  if (!table) throw new AppError("invalid_restore");
  await db
    .updateTable("views")
    .set({ deletedAt: null, deletedBy: null })
    .where("id", "=", view.id)
    .execute();
}

/** A view in the trash, for the restore and purge checks. */
export async function loadTrashedView(
  db: Database,
  viewId: string,
): Promise<ViewRow> {
  const view = await db
    .selectFrom("views")
    .selectAll()
    .where("id", "=", viewId)
    .where("deletedAt", "is not", null)
    .executeTakeFirst();
  if (!view) throw new AppError("no_row");
  return view;
}

/** The table of a field in the trash, whatever state the table is in. */
export async function trashedColumnTable(
  db: Database,
  columnId: string,
): Promise<{ tableId: string; baseId: string }> {
  const row = await db
    .selectFrom("dataColumns as c")
    .innerJoin("dataTables as t", "t.id", "c.tableId")
    .select(["c.tableId", "t.baseId"])
    .where("c.id", "=", columnId)
    .where("c.deletedAt", "is not", null)
    .executeTakeFirst();
  if (!row) throw new AppError("no_row");
  return row;
}

/** A table in the trash, with its base. */
export async function loadTrashedTable(
  db: Database,
  tableId: string,
): Promise<TableRow> {
  const table = await db
    .selectFrom("dataTables")
    .selectAll()
    .where("id", "=", tableId)
    .where("deletedAt", "is not", null)
    .executeTakeFirst();
  if (!table) throw new AppError("no_row");
  return table;
}

/* ------------------------------------------------------------------ */
/* Listing                                                             */
/* ------------------------------------------------------------------ */

export type TrashEntry = {
  kind: TrashItem["kind"];
  id: string;
  name: string;
  tableId: string | null;
  tableName: string | null;
  type: string | null;
  deletedAt: string;
  deletedBy: string | null;
  purgeAt: string;
};

function entry(
  kind: TrashEntry["kind"],
  row: {
    id: string;
    name: string;
    deletedAt: Date | null;
    deletedBy: string | null;
    tableId?: string;
    tableName?: string;
    type?: string;
  },
): TrashEntry {
  const deletedAt = row.deletedAt ?? new Date();
  return {
    kind,
    id: row.id,
    name: row.name,
    tableId: row.tableId ?? null,
    tableName: row.tableName ?? null,
    type: row.type ?? null,
    deletedAt: deletedAt.toISOString(),
    deletedBy: row.deletedBy,
    purgeAt: purgeDate(deletedAt).toISOString(),
  };
}

/**
 * What a base's trash holds: its tables, the fields and views of tables
 * still in use, and the caller's own personal views. Fields that went
 * with a table come back with it and are not listed on their own.
 */
export async function listTrash(
  db: Database,
  baseId: string,
  userId: string,
): Promise<TrashEntry[]> {
  const tableRows = await db
    .selectFrom("dataTables as t")
    .leftJoin("users as u", "u.id", "t.deletedBy")
    .select(["t.id", "t.name", "t.deletedAt", "u.displayName as deletedBy"])
    .where("t.baseId", "=", baseId)
    .where("t.deletedAt", "is not", null)
    .execute();
  const columnRows = await db
    .selectFrom("dataColumns as c")
    .innerJoin("dataTables as t", "t.id", "c.tableId")
    .leftJoin("users as u", "u.id", "c.deletedBy")
    .select([
      "c.id",
      "c.label as name",
      "c.fieldType as type",
      "c.tableId",
      "t.name as tableName",
      "c.deletedAt",
      "u.displayName as deletedBy",
    ])
    .where("t.baseId", "=", baseId)
    .where(liveTable("t"))
    .where("c.deletedAt", "is not", null)
    .where("c.deletedWith", "is", null)
    .execute();
  const viewRows = await db
    .selectFrom("views as v")
    .innerJoin("dataTables as t", "t.id", "v.tableId")
    .leftJoin("users as u", "u.id", "v.deletedBy")
    .select([
      "v.id",
      "v.name",
      "v.viewType as type",
      "v.tableId",
      "t.name as tableName",
      "v.deletedAt",
      "u.displayName as deletedBy",
    ])
    .where("t.baseId", "=", baseId)
    .where(liveTable("t"))
    .where("v.deletedAt", "is not", null)
    .where((eb) =>
      eb.or([eb("v.ownerId", "is", null), eb("v.ownerId", "=", userId)]),
    )
    .execute();
  return [
    ...tableRows.map((row) => entry("table", row)),
    ...columnRows.map((row) => entry("column", row)),
    ...viewRows.map((row) => entry("view", row)),
  ].sort((left, right) => right.deletedAt.localeCompare(left.deletedAt));
}

/** Bases in the trash among `baseIds`, the ones the caller may restore. */
export async function listTrashedBases(
  db: Database,
  baseIds: readonly string[],
): Promise<TrashEntry[]> {
  if (baseIds.length === 0) return [];
  const rows = await db
    .selectFrom("bases as b")
    .leftJoin("users as u", "u.id", "b.deletedBy")
    .select(["b.id", "b.name", "b.deletedAt", "u.displayName as deletedBy"])
    .where("b.id", "in", [...baseIds])
    .where("b.deletedAt", "is not", null)
    .orderBy("b.deletedAt", "asc")
    .execute();
  return rows.map((row) => entry("base", row));
}

/* ------------------------------------------------------------------ */
/* Purging                                                             */
/* ------------------------------------------------------------------ */

export type PurgeDeps = {
  db: Database;
  files: FileStore;
  log: (error: unknown, message: string) => void;
};

/** An item to purge and the account its catalog changes are audited under. */
export type PurgeTarget = TrashItem & { actorId: string };

/** Drops one item of the trash for good. An item no longer there is skipped. */
export async function purgeItem(
  deps: PurgeDeps,
  target: PurgeTarget,
): Promise<boolean> {
  const onFileError = (error: unknown) =>
    deps.log(error, "attachment delete failed");
  switch (target.kind) {
    case "view": {
      // Audited: the calendar feeds of the view go with it.
      const removed = await withAudit(
        deps.db,
        { userId: target.actorId, source: "purge" },
        (tx) =>
          tx
            .deleteFrom("views")
            .where("id", "=", target.id)
            .where("deletedAt", "is not", null)
            .returning("id")
            .execute(),
      );
      return removed.length > 0;
    }
    case "column": {
      try {
        const { attachmentKeys } = await purgeColumn(
          deps.db,
          target.actorId,
          target.id,
        );
        await deleteFiles(deps.files, attachmentKeys, onFileError);
        return true;
      } catch (error) {
        if (error instanceof Error && error.message === "No row") return false;
        throw error;
      }
    }
    case "table": {
      const table = await deps.db
        .selectFrom("dataTables")
        .select("id")
        .where("id", "=", target.id)
        .where("deletedAt", "is not", null)
        .executeTakeFirst();
      if (!table) return false;
      await removeTable(
        deps.db,
        deps.files,
        target.actorId,
        target.id,
        onFileError,
      );
      return true;
    }
    case "base": {
      const base = await deps.db
        .selectFrom("bases")
        .select("id")
        .where("id", "=", target.id)
        .where("deletedAt", "is not", null)
        .executeTakeFirst();
      if (!base) return false;
      await removeBase(
        deps.db,
        deps.files,
        target.actorId,
        target.id,
        onFileError,
      );
      return true;
    }
  }
}

/**
 * Every top-level item of a base's trash, for "empty the trash". Views
 * and fields go first, then tables, so nothing is purged twice.
 */
export async function baseTrashItems(
  db: Database,
  baseId: string,
  userId: string,
): Promise<TrashItem[]> {
  const listed = await listTrash(db, baseId, userId);
  return orderForPurge(
    listed.map((item) => ({ kind: item.kind, id: item.id })),
  );
}

const PURGE_ORDER: Record<TrashItem["kind"], number> = {
  view: 0,
  column: 1,
  table: 2,
  base: 3,
};

export function orderForPurge<T extends TrashItem>(items: readonly T[]): T[] {
  return [...items].sort(
    (left, right) => PURGE_ORDER[left.kind] - PURGE_ORDER[right.kind],
  );
}

/**
 * Items deleted more than 30 days ago, audited under whoever deleted
 * them, or the oldest administrator when that account is gone.
 */
export async function dueTrashItems(
  db: Database,
  now: Date,
): Promise<PurgeTarget[]> {
  const cutoff = purgeCutoff(now);
  const admin = await db
    .selectFrom("users")
    .select("id")
    .where("isAdmin", "=", true)
    .orderBy("createdAt", "asc")
    .limit(1)
    .executeTakeFirst();
  const actor = (deletedBy: string | null) => deletedBy ?? admin?.id;
  const found: Array<TrashItem & { actorId: string | undefined }> = [];
  for (const row of await db
    .selectFrom("views")
    .select(["id", "deletedBy as by"])
    .where("deletedAt", "<", cutoff)
    .execute()) {
    found.push({ kind: "view", id: row.id, actorId: actor(row.by) });
  }
  for (const row of await db
    .selectFrom("dataColumns")
    .select(["id", "deletedBy as by"])
    .where("deletedAt", "<", cutoff)
    .where("deletedWith", "is", null)
    .execute()) {
    found.push({ kind: "column", id: row.id, actorId: actor(row.by) });
  }
  for (const row of await db
    .selectFrom("dataTables")
    .select(["id", "deletedBy as by"])
    .where("deletedAt", "<", cutoff)
    .execute()) {
    found.push({ kind: "table", id: row.id, actorId: actor(row.by) });
  }
  for (const row of await db
    .selectFrom("bases")
    .select(["id", "deletedBy as by"])
    .where("deletedAt", "<", cutoff)
    .execute()) {
    found.push({ kind: "base", id: row.id, actorId: actor(row.by) });
  }
  return orderForPurge(
    found.filter((item): item is PurgeTarget => Boolean(item.actorId)),
  );
}

/** The base an item belongs to, whether or not it is in the trash. */
export async function itemBaseId(
  db: Database,
  item: TrashItem,
): Promise<string | undefined> {
  switch (item.kind) {
    case "base":
      return item.id;
    case "table": {
      const row = await db
        .selectFrom("dataTables")
        .select("baseId")
        .where("id", "=", item.id)
        .executeTakeFirst();
      return row?.baseId;
    }
    case "column": {
      const row = await db
        .selectFrom("dataColumns as c")
        .innerJoin("dataTables as t", "t.id", "c.tableId")
        .select("t.baseId")
        .where("c.id", "=", item.id)
        .executeTakeFirst();
      return row?.baseId;
    }
    case "view": {
      const row = await db
        .selectFrom("views as v")
        .innerJoin("dataTables as t", "t.id", "v.tableId")
        .select("t.baseId")
        .where("v.id", "=", item.id)
        .executeTakeFirst();
      return row?.baseId;
    }
  }
}
