import {
  AppError,
  type BaseTemplate,
  type CellValue,
  type ColumnDefinition,
  CREATABLE_TYPES,
  deriveColumnName,
  type EngineCatalog,
  type FieldType,
  type FormulaExpr,
  isWritableType,
  type MadeNames,
  localizeTemplate,
  madeNames,
  type ReadSpec,
  ROLLUP_FNS,
  type RollupFn,
} from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { insertComputed } from "./computed.js";
import {
  loadEngine,
  sortColumns,
  type ColumnRow,
  type TableRow,
} from "./engine.js";
import { liveView, trashedColumnNames } from "./live.js";
import { addRelation, setLinks } from "./relations.js";
import {
  readPage,
  writeColumns,
  type RowRecord,
  type WriteContext,
} from "./rows.js";
import { insertNativeBatch, updateNativeBatch } from "../services/rows.js";
import { addColumn, insertTable, setPrimaryColumn } from "./schema-ops.js";
import { createView } from "./views.js";

/** Rows copied by one duplication; larger tables are refused up front. */
export const MAX_COPY_ROWS = 100_000;
const PAGE = 1000;
const BATCH = 500;

const COMPUTED_TYPES = new Set<FieldType>(["lookup", "rollup"]);
const LINK_TYPES = new Set<FieldType>([
  "relation_one_to_many",
  "relation_many_to_many",
]);

function writeContext(
  userId: string,
  table: { id: string; physicalName: string; baseId: string },
  source: string,
): WriteContext {
  return {
    userId,
    tableId: table.id,
    physicalName: table.physicalName,
    baseId: table.baseId,
    reason: null,
    source,
  };
}

function isRollupFn(value: unknown): value is RollupFn {
  return (
    typeof value === "string" &&
    (ROLLUP_FNS as readonly string[]).includes(value)
  );
}

/** A read value back into a writable cell; empty arrays stay empty. */
export function toCell(value: unknown): CellValue {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) {
    return value.map((item) =>
      item && typeof item === "object" && "key" in item
        ? String((item as { key: unknown }).key)
        : String(item),
    );
  }
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  return null;
}

function creatable(fieldType: FieldType): ColumnDefinition["fieldType"] {
  const found = CREATABLE_TYPES.find((type) => type === fieldType);
  if (!found) {
    throw new AppError("invalid_column");
  }
  return found;
}

function definitionOf(column: ColumnRow): ColumnDefinition {
  const config = { ...(column.config ?? {}) };
  const expr = config.expr as FormulaExpr | undefined;
  delete config.expr;
  delete config.inverseOf;
  return {
    name: column.name,
    label: column.label,
    fieldType: creatable(column.fieldType),
    description: column.description ?? undefined,
    requireReason: column.requireReason,
    unique: column.isUnique,
    config,
    formula: column.fieldType === "formula" ? expr : undefined,
  };
}

/* ------------------------------------------------------------------ */
/* Templates                                                           */
/* ------------------------------------------------------------------ */

/**
 * Builds every table of a template, then its two-way links, rollups,
 * sample rows, and views. Sample rows are audited with source `template`.
 */
export async function applyTemplate(
  db: Database,
  userId: string,
  baseId: string,
  template: BaseTemplate,
  names: MadeNames = madeNames(),
): Promise<string[]> {
  // Written in the asker's language: the base is theirs to read.
  template = localizeTemplate(template, names.locale);
  const ids = new Map<string, string>();
  for (const table of template.tables) {
    const created = await insertTable(db, userId, {
      baseId,
      name: table.name,
      columns: table.columns,
      viewName: names.grid,
    });
    ids.set(table.key, created.id);
  }
  const rowIds = new Map<string, string[]>();
  for (const table of template.tables) {
    const tableId = ids.get(table.key);
    if (!tableId || !table.rows?.length) continue;
    const { engine, rows } = await loadEngine(db, tableId, () => true);
    const physical = rows.tables.find((item) => item.id === tableId);
    if (!physical) continue;
    const writable = new Set(writeColumns(engine).map((column) => column.name));
    const values = table.rows.map((row) =>
      Object.fromEntries(
        Object.entries(row).filter(([key]) => writable.has(key)),
      ),
    );
    rowIds.set(
      table.key,
      await insertNativeBatch(
        db,
        engine,
        writeContext(userId, physical, "template"),
        values,
      ),
    );
  }
  for (const link of template.links ?? []) {
    const from = ids.get(link.from);
    const to = ids.get(link.to);
    if (!from || !to) continue;
    const created = await addRelation(db, userId, {
      tableId: from,
      label: link.label,
      kind: link.multiple ? "many_to_many" : "one_to_many",
      targetTableId: to,
      twoWay: true,
      inverseLabel: link.inverseLabel,
      name: link.name,
      inverseName: link.inverseName,
    });
    if (!link.rows?.length) continue;
    const fromRows = rowIds.get(link.from) ?? [];
    const toRows = rowIds.get(link.to) ?? [];
    const { engine, rows } = await loadEngine(db, from, () => true);
    const physical = rows.tables.find((item) => item.id === from);
    const column = engine.table.columns.find(
      (item) => item.name === created.name,
    );
    if (!physical || !column) continue;
    const byRow = new Map<string, string[]>();
    for (const [fromIndex, toIndex] of link.rows) {
      const rowId = fromRows[fromIndex];
      const targetId = toRows[toIndex];
      if (rowId && targetId) {
        byRow.set(rowId, [...(byRow.get(rowId) ?? []), targetId]);
      }
    }
    for (const [rowId, targetIds] of byRow) {
      await setLinks(db, engine, {
        userId,
        tableId: from,
        physicalName: physical.physicalName,
        column,
        rowId,
        targetIds: link.multiple ? targetIds : targetIds.slice(0, 1),
        reason: null,
        source: "template",
      });
    }
  }
  for (const computed of template.computed ?? []) {
    const tableId = ids.get(computed.table);
    if (!tableId) continue;
    await insertComputed(
      db,
      userId,
      {
        tableId,
        label: computed.label,
        relation: computed.relation,
        target: computed.target,
        fn: computed.fn,
      },
      () => true,
    );
  }
  for (const table of template.tables) {
    const tableId = ids.get(table.key);
    if (!tableId || !table.views?.length) continue;
    const { engine } = await loadEngine(db, tableId, () => true);
    for (const view of table.views) {
      await createView(db, engine, {
        tableId,
        name: view.name,
        viewType: view.viewType,
        config: view.config,
        ownerId: null,
      });
    }
  }
  return [...ids.values()];
}

/* ------------------------------------------------------------------ */
/* Duplication                                                         */
/* ------------------------------------------------------------------ */

/** Reads every row in pages of 1000, up to `MAX_COPY_ROWS`. */
export async function readAll(
  db: Database,
  engine: EngineCatalog,
  fields: string[],
  onPage: (rows: RowRecord[]) => void | Promise<void>,
  base: Omit<ReadSpec, "limit" | "offset" | "fields"> = {},
): Promise<void> {
  for (let offset = 0; offset < MAX_COPY_ROWS; offset += PAGE) {
    const page = await readPage(
      db,
      engine,
      { ...base, limit: PAGE, offset, fields, groupBy: undefined },
      { total: false },
    );
    await onPage(page.rows);
    if (page.rows.length < PAGE) return;
  }
}

/**
 * Copies a table into the same base: stored and system columns, formulas,
 * outgoing links, and the lookups and rollups over them, plus the first
 * view's settings. With `withData`, rows and their links come too, audited
 * as inserts with source `duplicate`. Attachment cells are left empty: a
 * file belongs to exactly one table.
 */
export async function duplicateTable(
  db: Database,
  userId: string,
  source: TableRow,
  input: {
    name: string;
    withData: boolean;
    /** Learns the copy's id as soon as it exists, to clean up after a failure. */
    onCreated?: (tableId: string) => void;
    /** Called after each page of copied rows. */
    onProgress?: (done: number, total: number | null) => Promise<void>;
  },
): Promise<{ id: string }> {
  // Copying a client's table into AnyGridDB is the synced mode, not yet.
  if (source.storage === "external") {
    throw new AppError("external_table_read_only");
  }
  const { engine, rows } = await loadEngine(db, source.id, () => true);
  let total: number | null = null;
  if (input.withData) {
    const counted = await readPage(
      db,
      engine,
      { limit: 1, fields: [] },
      { total: true },
    );
    total = counted.total ?? 0;
    if (total > MAX_COPY_ROWS) {
      throw new AppError("too_many_rows");
    }
  }
  await input.onProgress?.(0, total);
  const own = sortColumns(
    rows.columns.filter((column) => column.tableId === source.id),
  );
  const stored = own.filter(
    (column) =>
      !LINK_TYPES.has(column.fieldType) &&
      !COMPUTED_TYPES.has(column.fieldType) &&
      column.fieldType !== "formula",
  );
  const created = await insertTable(db, userId, {
    baseId: source.baseId,
    name: input.name,
    description: source.description ?? undefined,
    columns: stored.map(definitionOf),
  });
  input.onCreated?.(created.id);

  const links = new Map<string, string>();
  for (const column of own.filter((item) => LINK_TYPES.has(item.fieldType))) {
    const engineColumn = engine.table.columns.find(
      (item) => item.id === column.id,
    );
    const relation = engineColumn?.relation;
    if (!relation || relation.direction !== "forward") continue;
    const added = await addRelation(db, userId, {
      tableId: created.id,
      name: column.name,
      label: column.label,
      kind: relation.kind,
      targetTableId:
        relation.targetTableId === source.id
          ? created.id
          : relation.targetTableId,
    });
    links.set(column.name, added.name);
  }
  for (const column of own.filter((item) =>
    COMPUTED_TYPES.has(item.fieldType),
  )) {
    const config = column.config ?? {};
    const relation =
      typeof config.relation === "string"
        ? links.get(config.relation)
        : undefined;
    if (!relation || typeof config.target !== "string") continue;
    await insertComputed(
      db,
      userId,
      {
        tableId: created.id,
        name: column.name,
        label: column.label,
        relation,
        target: config.target,
        fn: isRollupFn(config.fn) ? config.fn : undefined,
      },
      () => true,
    );
  }
  // Formulas may reference each other in any order: add what compiles
  // until a pass makes no progress, then drop the rest.
  let pending = own.filter((column) => column.fieldType === "formula");
  while (pending.length > 0) {
    const failed: ColumnRow[] = [];
    for (const column of pending) {
      try {
        await addColumn(db, userId, created.id, definitionOf(column));
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !error.message.startsWith("Unknown column")
        ) {
          throw error;
        }
        failed.push(column);
      }
    }
    if (failed.length === pending.length) break;
    pending = failed;
  }
  const primary = own.find((column) => column.isPrimary);
  if (primary && stored.some((column) => column.name === primary.name)) {
    await setPrimaryColumn(db, userId, created.id, primary.name);
  }
  const firstView = await db
    .selectFrom("views")
    .selectAll()
    .where("tableId", "=", source.id)
    .where(liveView())
    .orderBy("position", "asc")
    .limit(1)
    .executeTakeFirst();
  const copyView = await db
    .selectFrom("views")
    .selectAll()
    .where("tableId", "=", created.id)
    .limit(1)
    .executeTakeFirst();
  if (firstView && copyView) {
    await db
      .updateTable("views")
      .set({ config: firstView.config, name: firstView.name })
      .where("id", "=", copyView.id)
      .execute();
  }

  if (input.withData) {
    const target = await loadEngine(db, created.id, () => true);
    const physical = target.rows.tables.find((item) => item.id === created.id);
    if (!physical) {
      throw new AppError("no_row");
    }
    const writable = writeColumns(target.engine)
      .filter((column) => column.fieldType !== "attachment")
      .map((column) => column.name);
    const linkColumns = [...links].flatMap(([oldName, newName]) => {
      const column = target.engine.table.columns.find(
        (item) => item.name === newName,
      );
      return column ? [{ oldName, column }] : [];
    });
    // Links are set once every row exists, so a link from the table to
    // itself can point at the copied rows.
    const copied = new Map<string, string>();
    const pendingLinks: Array<{
      rowId: string;
      column: (typeof linkColumns)[number]["column"];
      targetIds: string[];
    }> = [];
    await readAll(
      db,
      engine,
      [...writable, ...linkColumns.map((item) => item.oldName)],
      async (page) => {
        const newIds = await insertNativeBatch(
          db,
          target.engine,
          writeContext(userId, physical, "duplicate"),
          page.map((row) =>
            Object.fromEntries(
              writable.map((name) => [name, toCell(row[name])]),
            ),
          ),
        );
        await input.onProgress?.(copied.size + newIds.length, total);
        for (const [index, row] of page.entries()) {
          const rowId = newIds[index];
          if (!rowId) continue;
          copied.set(row.id, rowId);
          for (const { oldName, column } of linkColumns) {
            const value = row[oldName];
            if (!Array.isArray(value) || value.length === 0) continue;
            pendingLinks.push({
              rowId,
              column,
              targetIds: value.map((link) =>
                String((link as { id: unknown }).id),
              ),
            });
          }
        }
      },
    );
    for (const link of pendingLinks) {
      const self = link.column.relation?.targetTableId === created.id;
      await setLinks(db, target.engine, {
        userId,
        tableId: created.id,
        physicalName: physical.physicalName,
        column: link.column,
        rowId: link.rowId,
        targetIds: self
          ? link.targetIds.flatMap((id) => copied.get(id) ?? [])
          : link.targetIds,
        reason: null,
        source: "duplicate",
      });
    }
  }
  return { id: created.id };
}

/**
 * Adds a copy of a stored or formula column right after it. Stored values
 * are copied with audited updates; locked and signed rows keep an empty
 * cell and are counted in `skipped`.
 */
export async function duplicateColumn(
  db: Database,
  userId: string,
  table: TableRow,
  name: string,
  names: MadeNames = madeNames(),
): Promise<{ name: string; skipped: number }> {
  const { engine, rows } = await loadEngine(db, table.id, () => true);
  const own = rows.columns.filter((item) => item.tableId === table.id);
  const column = own.find((item) => item.name === name);
  if (
    !column ||
    (!isWritableType(column.fieldType) && column.fieldType !== "formula")
  ) {
    throw new AppError("invalid_column");
  }
  const labels = new Set(own.map((item) => item.label));
  let label = names.copy(column.label).slice(0, 100);
  for (let index = 2; labels.has(label); index += 1) {
    label = names.copy(column.label, index).slice(0, 100);
  }
  const definition = definitionOf(column);
  const created = await addColumn(
    db,
    userId,
    table.id,
    {
      ...definition,
      name: deriveColumnName(
        label,
        new Set([
          ...own.map((item) => item.name),
          ...(await trashedColumnNames(db, table.id)),
        ]),
      ),
      label,
      unique: false,
    },
    column.position + 1,
  );
  let skipped = 0;
  if (!isWritableType(column.fieldType)) {
    return { name: created.name, skipped };
  }
  const target = await loadEngine(db, table.id, () => true);
  await readAll(db, engine, [column.name], async (page) => {
    const updates = page.flatMap((row) => {
      const cell = toCell(row[column.name]);
      if (cell === null || (Array.isArray(cell) && cell.length === 0)) {
        return [];
      }
      if (row.ag_status === "locked" || row.ag_status === "signed") {
        skipped += 1;
        return [];
      }
      return [{ rowId: row.id, values: { [created.name]: cell } }];
    });
    for (let index = 0; index < updates.length; index += BATCH) {
      await updateNativeBatch(
        db,
        target.engine,
        writeContext(userId, table, "duplicate"),
        updates.slice(index, index + BATCH),
      );
    }
  });
  return { name: created.name, skipped };
}
