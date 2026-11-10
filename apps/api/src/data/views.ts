import {
  AppError,
  applyViewConfigPatch,
  buildReadRows,
  type EngineCatalog,
  normalizeViewConfig,
  pruneViewConfig,
  type ViewConfig,
  viewConfigColumns,
  type ViewConfigPatch,
  type ViewType,
} from "@anygriddb/core";
import type { Database, ViewRow } from "@anygriddb/db";
import { sql as sqlTag } from "kysely";
import { liveColumnNames, liveView, trashedColumnNames } from "./live.js";
import { clientFilter } from "../sources/control-plane-read-filter.js";

export type { ViewRow };

async function nextViewPosition(db: Database, tableId: string) {
  const row = await db
    .selectFrom("views")
    .select(sqlTag<number>`coalesce(max(position) + 1, 0)::int`.as("max"))
    .where("tableId", "=", tableId)
    .executeTakeFirst();
  return row?.max ?? 0;
}

/**
 * A view as clients see it. With `known`, references to fields outside
 * that set (fields in the trash) are left out; the stored config keeps them.
 */
export function publicView(view: ViewRow, known?: ReadonlySet<string>) {
  const config = normalizeViewConfig(view.config, view.viewType);
  return {
    id: view.id,
    tableId: view.tableId,
    name: view.name,
    viewType: view.viewType,
    config: known ? pruneViewConfig(config, known) : config,
    position: view.position,
    personal: view.ownerId !== null,
    locked: view.locked,
  };
}

export async function loadView(db: Database, viewId: string): Promise<ViewRow> {
  const view = await db
    .selectFrom("views")
    .selectAll()
    .where("id", "=", viewId)
    .where(liveView())
    .executeTakeFirst();
  if (!view) {
    throw new AppError("no_row");
  }
  return view;
}

/** Kept for callers that only need the table of a view. */
export async function viewTableId(
  db: Database,
  viewId: string,
): Promise<string> {
  return (await loadView(db, viewId)).tableId;
}

/** Collaborative views plus the caller's personal ones, in tab order. */
export async function listViews(db: Database, tableId: string, userId: string) {
  const rows = await db
    .selectFrom("views")
    .selectAll()
    .where("tableId", "=", tableId)
    .where((eb) =>
      eb.or([eb("ownerId", "is", null), eb("ownerId", "=", userId)]),
    )
    .where(liveView())
    .orderBy("position", "asc")
    .orderBy("createdAt", "asc")
    .execute();
  const known = await liveColumnNames(db, tableId);
  return rows.map((row) => publicView(row, known));
}

/**
 * Rejects a configuration that names unknown columns or cannot compile.
 * Names in `reserved`, fields in the trash, may stay: they are skipped.
 */
export function assertViewConfig(
  engine: EngineCatalog,
  stored: ViewConfig,
  reserved: ReadonlySet<string> = new Set(),
): void {
  const known = new Set(engine.table.columns.map((column) => column.name));
  for (const name of viewConfigColumns(stored)) {
    if (!known.has(name) && !reserved.has(name)) {
      throw new AppError("invalid_view");
    }
  }
  const config = pruneViewConfig(stored, known);
  try {
    // Fields kept in AnyGridDB filter a view apart from its query (ADR 0046).
    buildReadRows(engine, {
      limit: 1,
      filter: clientFilter(engine, config.filter),
      sort: config.sort,
      groupBy: config.groupBy,
    });
    for (const rule of config.color?.rules ?? []) {
      buildReadRows(engine, {
        limit: 1,
        filter: clientFilter(engine, rule.filter, { check: false }),
      });
    }
  } catch (error) {
    throw new AppError("invalid_view", { cause: error });
  }
}

export function canEditView(
  view: ViewRow,
  userId: string,
  role: "owner" | "editor" | "commenter" | "viewer",
): boolean {
  if (view.ownerId) {
    return view.ownerId === userId;
  }
  if (view.locked) {
    return role === "owner";
  }
  return role === "owner" || role === "editor";
}

export async function createView(
  db: Database,
  engine: EngineCatalog,
  input: {
    tableId: string;
    name: string;
    viewType: ViewType;
    config?: ViewConfig;
    ownerId: string | null;
  },
) {
  const config = normalizeViewConfig(input.config ?? {}, input.viewType);
  assertViewConfig(engine, config);
  const known = new Set(engine.table.columns.map((column) => column.name));
  const inserted = await db
    .insertInto("views")
    .values({
      tableId: input.tableId,
      name: input.name,
      viewType: input.viewType,
      config: config as Record<string, unknown>,
      position: await nextViewPosition(db, input.tableId),
      ownerId: input.ownerId,
    })
    .returningAll()
    .executeTakeFirst();
  if (!inserted) {
    throw new AppError("no_row");
  }
  return publicView(inserted, known);
}

export async function updateView(
  db: Database,
  engine: EngineCatalog,
  view: ViewRow,
  input: {
    name?: string;
    config?: ViewConfig;
    patch?: ViewConfigPatch;
    locked?: boolean;
  },
) {
  const current = normalizeViewConfig(view.config, view.viewType);
  const base = input.config
    ? normalizeViewConfig(input.config, view.viewType)
    : current;
  const next = input.patch ? applyViewConfigPatch(base, input.patch) : base;
  assertViewConfig(
    engine,
    next,
    new Set(await trashedColumnNames(db, view.tableId)),
  );
  const updated = await db
    .updateTable("views")
    .set({
      name: input.name ?? view.name,
      config: next as Record<string, unknown>,
      ...(input.locked !== undefined ? { locked: input.locked } : {}),
    })
    .where("id", "=", view.id)
    .returningAll()
    .executeTakeFirst();
  if (!updated) {
    throw new AppError("no_row");
  }
  return publicView(
    updated,
    new Set(engine.table.columns.map((column) => column.name)),
  );
}

export async function duplicateView(
  db: Database,
  view: ViewRow,
  name: string,
  ownerId: string | null,
) {
  const inserted = await db
    .insertInto("views")
    .values({
      tableId: view.tableId,
      name,
      viewType: view.viewType,
      config: view.config,
      position: await nextViewPosition(db, view.tableId),
      ownerId,
    })
    .returningAll()
    .executeTakeFirst();
  if (!inserted) {
    throw new AppError("no_row");
  }
  return publicView(inserted, await liveColumnNames(db, view.tableId));
}

export async function reorderViews(
  db: Database,
  tableId: string,
  order: readonly string[],
): Promise<void> {
  const rows = await db
    .selectFrom("views")
    .select("id")
    .where("tableId", "=", tableId)
    .where(liveView())
    .execute();
  const ids = new Set(rows.map((row) => row.id));
  if (order.some((id) => !ids.has(id))) {
    throw new AppError("invalid_order");
  }
  await db.transaction().execute(async (tx) => {
    for (const [index, id] of order.entries()) {
      await tx
        .updateTable("views")
        .set({ position: index })
        .where("id", "=", id)
        .execute();
    }
  });
}

/** Moves a view to the trash. A table keeps at least one shared view. */
export async function trashView(
  db: Database,
  userId: string,
  view: ViewRow,
): Promise<void> {
  if (!view.ownerId) {
    const siblings = await db
      .selectFrom("views")
      .select("id")
      .where("tableId", "=", view.tableId)
      .where("ownerId", "is", null)
      .where(liveView())
      .execute();
    if (siblings.length < 2) {
      throw new AppError("invalid_view");
    }
  }
  await db
    .updateTable("views")
    .set({ deletedAt: new Date(), deletedBy: userId })
    .where("id", "=", view.id)
    .where(liveView())
    .execute();
}
