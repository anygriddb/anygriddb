import {
  AppError,
  applyViewConfigPatch,
  buildReadRows,
  type EngineCatalog,
  keepHiddenParts,
  keepTrashedParts,
  normalizeViewConfig,
  pruneViewConfig,
  type Grant,
  type ViewConfig,
  viewConfigColumns,
  viewConfigForReader,
  type ViewConfigPatch,
  type ViewType,
} from "@anygriddb/core";
import { granted } from "../access/declaration.js";
import type { Database, ViewRow } from "@anygriddb/db";
import { sql as sqlTag } from "kysely";
import { withAudit } from "./audit-context.js";
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

const NO_FIELDS: ReadonlySet<string> = new Set();

/**
 * A view as clients see it. With `known`, references to fields outside
 * that set (fields in the trash) are left out, and so is what it says of
 * the fields in `hidden`, those the reader's rules hide. The stored config
 * keeps them all.
 */
function publicView(
  view: ViewRow,
  known?: ReadonlySet<string>,
  hidden: ReadonlySet<string> = NO_FIELDS,
) {
  const config = normalizeViewConfig(view.config, view.viewType);
  const shown = known ? pruneViewConfig(config, known) : config;
  return {
    id: view.id,
    tableId: view.tableId,
    name: view.name,
    viewType: view.viewType,
    config: viewConfigForReader(shown, hidden),
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
    throw new AppError("unknown_view");
  }
  return view;
}

/** Collaborative views plus the caller's personal ones, in tab order. */
export async function listViews(
  db: Database,
  tableId: string,
  userId: string,
  hidden: ReadonlySet<string> = NO_FIELDS,
) {
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
  return rows.map((row) => publicView(row, known, hidden));
}

/**
 * Rejects a configuration that names unknown columns or cannot compile.
 * Names in `reserved`, fields in the trash, may stay: they are skipped.
 */
function assertViewConfig(
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
  role: Grant,
): boolean {
  if (view.ownerId) {
    return view.ownerId === userId;
  }
  return granted(role, view.locked ? "schema.manage" : "views.manage");
}

export async function createView(
  db: Database,
  engine: EngineCatalog,
  userId: string,
  input: {
    tableId: string;
    name: string;
    viewType: ViewType;
    config?: ViewConfig;
    ownerId: string | null;
  },
  /** Fields the author's rules hide: a view they make says nothing of them. */
  hidden: ReadonlySet<string> = NO_FIELDS,
) {
  const config = viewConfigForReader(
    normalizeViewConfig(input.config ?? {}, input.viewType),
    hidden,
  );
  assertViewConfig(engine, config);
  const known = new Set(engine.table.columns.map((column) => column.name));
  const position = await nextViewPosition(db, input.tableId);
  const inserted = await withAudit(
    db,
    { userId, tableId: input.tableId, source: "web" },
    (tx) =>
      tx
        .insertInto("views")
        .values({
          tableId: input.tableId,
          name: input.name,
          viewType: input.viewType,
          config: config as Record<string, unknown>,
          position,
          ownerId: input.ownerId,
        })
        .returningAll()
        .executeTakeFirst(),
  );
  if (!inserted) {
    throw new AppError("no_row");
  }
  return publicView(inserted, known, hidden);
}

export async function updateView(
  db: Database,
  engine: EngineCatalog,
  userId: string,
  view: ViewRow,
  input: {
    name?: string;
    config?: ViewConfig;
    patch?: ViewConfigPatch;
    locked?: boolean;
  },
  source = "web",
  /** Fields the author's rules hide: what the view says of them stays. */
  hidden: ReadonlySet<string> = NO_FIELDS,
) {
  const current = normalizeViewConfig(view.config, view.viewType);
  const base = input.config
    ? normalizeViewConfig(input.config, view.viewType)
    : current;
  const trashed = new Set(await trashedColumnNames(db, view.tableId));
  // What was saved was seen without the fields in the trash: their part
  // of each setting saved stays, for when they come back.
  const keys = input.config ? "all" : Object.keys(input.patch ?? {});
  const next = keepTrashedParts(
    current,
    keepHiddenParts(
      current,
      input.patch ? applyViewConfigPatch(base, input.patch) : base,
      hidden,
      keys,
    ),
    trashed,
    keys,
  );
  assertViewConfig(engine, next, trashed);
  const updated = await withAudit(
    db,
    { userId, tableId: view.tableId, source },
    (tx) =>
      tx
        .updateTable("views")
        .set({
          name: input.name ?? view.name,
          config: next as Record<string, unknown>,
          ...(input.locked !== undefined ? { locked: input.locked } : {}),
        })
        .where("id", "=", view.id)
        .returningAll()
        .executeTakeFirst(),
  );
  if (!updated) {
    throw new AppError("no_row");
  }
  return publicView(
    updated,
    new Set(engine.table.columns.map((column) => column.name)),
    hidden,
  );
}

export async function duplicateView(
  db: Database,
  userId: string,
  view: ViewRow,
  name: string,
  ownerId: string | null,
  hidden: ReadonlySet<string> = NO_FIELDS,
) {
  const position = await nextViewPosition(db, view.tableId);
  const inserted = await withAudit(
    db,
    { userId, tableId: view.tableId, source: "web" },
    (tx) =>
      tx
        .insertInto("views")
        .values({
          tableId: view.tableId,
          name,
          viewType: view.viewType,
          config: view.config,
          position,
          ownerId,
        })
        .returningAll()
        .executeTakeFirst(),
  );
  if (!inserted) {
    throw new AppError("no_row");
  }
  return publicView(inserted, await liveColumnNames(db, view.tableId), hidden);
}

export async function reorderViews(
  db: Database,
  userId: string,
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
  await withAudit(db, { userId, tableId, source: "web" }, async (tx) => {
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
  await withAudit(db, { userId, tableId: view.tableId, source: "web" }, (tx) =>
    tx
      .updateTable("views")
      .set({ deletedAt: new Date(), deletedBy: userId })
      .where("id", "=", view.id)
      .where(liveView())
      .execute(),
  );
}
