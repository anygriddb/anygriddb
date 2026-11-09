/**
 * Which rows a link field offers and accepts: those of a shared view of
 * the linked table, or those matching a filter. The picker offers only
 * them, and a link added to another row is refused, whatever writes it:
 * the grid, a paste, the record panel, the API, a form, an automation.
 * Links already there stay when the selection changes.
 */
import {
  AppError,
  buildReadRows,
  type EngineCatalog,
  type EngineColumn,
  type FilterGroup,
  MAX_READ_LIMIT,
  normalizeViewConfig,
  viewFilter,
  type LinkSelection,
} from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { readTransaction } from "./rows.js";

export type SelectionFilter = {
  filter: FilterGroup | undefined;
  /** The view it names is gone, personal, or of another table. */
  missing: boolean;
};

/** The filter a link field's selection applies, if any. */
export async function selectionFilter(
  db: Database,
  column: EngineColumn,
): Promise<SelectionFilter> {
  const selection = column.config.selectFrom;
  if (!selection) return { filter: undefined, missing: false };
  if ("filter" in selection)
    return { filter: selection.filter, missing: false };
  const view = await db
    .selectFrom("views")
    .select(["tableId", "ownerId", "config", "viewType", "deletedAt"])
    .where("id", "=", selection.view)
    .executeTakeFirst();
  if (
    !view ||
    view.deletedAt !== null ||
    view.ownerId !== null ||
    view.tableId !== column.relation?.targetTableId
  ) {
    return { filter: undefined, missing: true };
  }
  return {
    filter: viewFilter(normalizeViewConfig(view.config, view.viewType)),
    missing: false,
  };
}

/**
 * Checks a selection as a link field is configured: a view shared on the
 * linked table, or a filter on its fields.
 */
export async function assertSelectionConfig(
  db: Database,
  target: EngineCatalog,
  selection: LinkSelection,
): Promise<void> {
  if ("filter" in selection) {
    buildReadRows(target, { limit: 1, filter: selection.filter });
    return;
  }
  const view = await db
    .selectFrom("views")
    .select(["tableId", "ownerId", "deletedAt"])
    .where("id", "=", selection.view)
    .executeTakeFirst();
  if (
    !view ||
    view.deletedAt !== null ||
    view.ownerId !== null ||
    view.tableId !== target.table.id
  ) {
    throw new AppError("invalid_link_selection");
  }
}

/**
 * Refuses links to rows outside a field's selection (`added`: the ids not
 * linked before). Read with the actor's rights on the linked table.
 */
export async function assertLinksInSelection(
  db: Database,
  engine: EngineCatalog,
  column: EngineColumn,
  added: readonly string[],
): Promise<void> {
  if (added.length === 0) return;
  const target = column.relation
    ? engine.tables.get(column.relation.targetTableId)
    : undefined;
  if (!target) return;
  const { filter } = await selectionFilter(db, column);
  if (!filter) return;
  const targetEngine: EngineCatalog = { ...engine, table: target };
  const unique = [...new Set(added)];
  const found = new Set<string>();
  for (let from = 0; from < unique.length; from += MAX_READ_LIMIT) {
    const ids = unique.slice(from, from + MAX_READ_LIMIT);
    const statement = buildReadRows(targetEngine, {
      limit: ids.length,
      rowIds: ids,
      filter,
      fields: [],
    });
    const rows = await readTransaction(db, targetEngine, (run) =>
      run(statement),
    );
    for (const row of rows) found.add(String((row as { id: unknown }).id));
  }
  if (unique.some((id) => !found.has(id))) {
    throw new AppError("link_outside_selection", column.label);
  }
}
