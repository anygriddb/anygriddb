import { randomBytes } from "node:crypto";
import {
  isSideFieldType,
  AppError,
  buildAddColumn,
  buildConversionOptions,
  buildConversionSwitch,
  buildConversionTempColumn,
  buildCountDuplicates,
  buildCountLocked,
  buildCreateTable,
  buildFileIndex,
  buildCountRowsUpTo,
  buildDropColumn,
  buildDropTable,
  buildDropUniqueIndex,
  buildLockOutWriters,
  buildReadRows,
  buildRenameConversionIndex,
  buildRenameOption,
  buildSetDefault,
  buildUniqueIndex,
  type ColumnConfig,
  type ColumnDefinition,
  conversionZone,
  deriveColumnName,
  describeColumns,
  type FieldType,
  type FormulaRef,
  formulaReferences,
  hasPhysicalColumn,
  isConvertible,
  isHomeTable,
  isMetadataConversion,
  isRelationType,
  isStoredAlike,
  isTimeZone,
  isWritableType,
  canBeRequired,
  madeNames,
  normalizeViewConfig,
  OPTION_COLORS,
  parseColumnConfig,
  PRIMARY_TYPES,
  rollupFitsTarget,
  parseFormula,
  pruneViewConfig,
  stripColumnFromConfig,
  viewFilter,
  ceilingOf,
} from "@anygriddb/core";

export { PRIMARY_TYPES };
import { runStatement, type Database, type Tx } from "@anygriddb/db";
import { sql as sqlTag } from "kysely";
import { runRows, withAudit, type AuditTx } from "./audit-context.js";
import { liveColumn, liveTable, trashedColumnNames } from "./live.js";
import { columnAttachmentKeys } from "./tables.js";
import { addSideField } from "../sources/enrich.js";
import {
  assembleEngine,
  columnConfig,
  loadCatalogRows,
  sortColumns,
  type CatalogRows,
  type ColumnRow,
  type TableRow,
} from "./engine.js";
import { rewriteField, tallyConversion } from "./conversion-rows.js";
import { assertSelectionConfig } from "./link-selection.js";
import { postgresCode } from "./pg-error.js";

const UNIQUE_TYPES: ReadonlySet<FieldType> = new Set([
  "text",
  "email",
  "url",
  "phone",
  "number",
  "date",
  "datetime",
  "single_select",
]);

function physicalTableName(): string {
  return `t_${randomBytes(16).toString("hex")}`;
}

export function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  if ("code" in error && error.code === "23505") {
    return true;
  }
  return "cause" in error ? isUniqueViolation(error.cause) : false;
}

type PlannedColumn = {
  name: string;
  label: string;
  fieldType: FieldType;
  description: string | null;
  requireReason: boolean;
  required: boolean;
  unique: boolean;
  config: ColumnConfig;
};

function assertUniqueLabel(
  existing: readonly { label: string }[],
  label: string,
): void {
  const folded = label.trim().toLowerCase();
  if (existing.some((column) => column.label.trim().toLowerCase() === folded)) {
    throw new AppError("column_already_exists");
  }
}

/** Resolves a column definition into a validated catalog row, without touching the database. */
function planColumn(
  definition: ColumnDefinition,
  existing: readonly { name: string; label: string }[],
  /** Names still held by fields in the trash, which keep their storage. */
  reserved: readonly string[] = [],
): PlannedColumn {
  const label = definition.label ?? definition.name ?? "";
  assertUniqueLabel(existing, label);
  const taken = new Set([
    ...existing.map((column) => column.name),
    ...reserved,
  ]);
  const name = definition.name ?? deriveColumnName(label, taken);
  if (taken.has(name)) {
    throw new AppError("column_already_exists");
  }
  const raw: Record<string, unknown> = { ...(definition.config ?? {}) };
  if (definition.options && raw.options === undefined) {
    raw.options = definition.options.map((option, index) => ({
      name: option,
      color: OPTION_COLORS[index % OPTION_COLORS.length],
    }));
  }
  if (definition.fieldType === "formula") {
    const refs: FormulaRef[] = existing.map((column) => ({
      name: column.name,
      label: column.label,
    }));
    if (definition.formulaSource) {
      raw.expr = parseFormula(definition.formulaSource, refs);
    } else if (definition.formula) {
      raw.expr = definition.formula;
    }
    if (!raw.expr) {
      throw new AppError("invalid_formula");
    }
  } else if (definition.formulaSource || definition.formula) {
    throw new AppError("invalid_formula");
  }
  const config = parseColumnConfig(definition.fieldType, raw);
  const unique = definition.unique === true;
  if (unique && !UNIQUE_TYPES.has(definition.fieldType)) {
    throw new AppError("invalid_column");
  }
  return {
    name,
    label,
    fieldType: definition.fieldType,
    description: definition.description ?? null,
    requireReason:
      definition.requireReason === true && isWritableType(definition.fieldType),
    required:
      definition.required === true && canBeRequired(definition.fieldType),
    unique,
    config,
  };
}

/**
 * Throws the compile error of a computed column, as the AppError it was
 * (`function_unavailable`, `unknown_column: x`), so the person reads why.
 */
function assertCompiles(
  rows: CatalogRows,
  tableId: string,
  name: string,
): void {
  const engine = assembleEngine(tableId, rows, () => true);
  const described = describeColumns(engine).find(
    (column) => column.name === name,
  );
  if (described?.cause) {
    throw new AppError(described.cause.code, described.cause.detail);
  }
  if (described?.error) {
    throw new Error(described.error);
  }
}

function withPlanned(
  rows: CatalogRows,
  table: TableRow,
  planned: readonly PlannedColumn[],
  offset: number,
): CatalogRows {
  return {
    ...rows,
    columns: [
      ...rows.columns,
      ...planned.map((column, index) => ({
        id: `planned-${index}`,
        tableId: table.id,
        name: column.name,
        physicalName: column.name,
        externalType: null,
        externalWritable: false,
        externalInsertable: false,
        externalSide: false,
        externalControlPlane: false,
        fieldType: column.fieldType,
        requireReason: column.requireReason,
        required: column.required,
        config: column.config,
        label: column.label,
        description: column.description,
        position: offset + index,
        isPrimary: false,
        isUnique: column.unique,
        deletedAt: null,
        deletedBy: null,
        deletedWith: null,
        purgeStartedAt: null,
      })),
    ],
  };
}

function defaultLiteral(
  column: PlannedColumn,
): string | number | boolean | undefined {
  const value = column.config.defaultValue;
  if (value === undefined) {
    return undefined;
  }
  if (
    column.fieldType === "single_select" &&
    !column.config.options?.some((option) => option.name === value)
  ) {
    throw new AppError("invalid_default");
  }
  return value;
}

export async function insertBase(
  db: Database,
  userId: string,
  input: { name: string; description?: string },
): Promise<{ id: string }> {
  return withAudit(db, { userId, source: "web" }, async (tx) => {
    const inserted = await tx
      .insertInto("bases")
      .values({ name: input.name, description: input.description ?? null })
      .returning("id")
      .executeTakeFirst();
    const id = inserted?.id;
    if (!id) {
      throw new AppError("no_row");
    }
    await tx
      .insertInto("roleBindings")
      .values({ userId, role: "owner", scope: "base", scopeId: id })
      .execute();
    return { id };
  });
}

export async function updateBase(
  db: Database,
  userId: string,
  input: { baseId: string; name?: string; description?: string | null },
  source = "web",
): Promise<void> {
  const changes = {
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.description !== undefined
      ? { description: input.description }
      : {}),
  };
  // Nothing to change: an update that sets nothing is no statement.
  if (Object.keys(changes).length === 0) return;
  await withAudit(db, { userId, source }, async (tx) => {
    await tx
      .updateTable("bases")
      .set(changes)
      .where("id", "=", input.baseId)
      .execute();
  });
}

async function createPhysicalColumns(
  tx: AuditTx,
  table: TableRow,
  planned: readonly PlannedColumn[],
): Promise<void> {
  for (const column of planned) {
    const fallback = defaultLiteral(column);
    if (fallback !== undefined && isWritableType(column.fieldType)) {
      await runRows(
        tx,
        buildSetDefault({
          table: table.physicalName,
          column,
          defaultValue: fallback,
        }),
      );
    }
    if (column.unique) {
      await runRows(
        tx,
        buildUniqueIndex({ table: table.physicalName, column: column.name }),
      );
    }
  }
}

export async function insertTable(
  db: Database,
  userId: string,
  input: {
    baseId: string;
    name: string;
    description?: string;
    columns: readonly ColumnDefinition[];
    /** The first view's name, in the asker's language; English otherwise. */
    viewName?: string;
  },
): Promise<{ id: string }> {
  const planned: PlannedColumn[] = [];
  for (const definition of input.columns) {
    planned.push(planColumn(definition, planned));
  }
  const physicalName = physicalTableName();
  const draftTable: TableRow = {
    id: "planned-table",
    baseId: input.baseId,
    name: input.name,
    storage: "native",
    physicalName,
    description: null,
    position: 0,
    folderId: null,
    createdAt: new Date(),
    deletedAt: null,
    deletedBy: null,
    sourceId: null,
    externalSchema: null,
    externalName: null,
    externalKey: null,
    externalUpdate: false,
    externalInsert: false,
    externalDelete: false,
    externalSide: null,
    trailReads: false,
    purgeStartedAt: null,
  };
  const rows = withPlanned(
    { tables: [draftTable], columns: [], relations: [], sources: new Map() },
    draftTable,
    planned,
    0,
  );
  for (const column of planned) {
    if (column.fieldType === "formula") {
      assertCompiles(rows, draftTable.id, column.name);
    }
  }
  const primaryIndex = planned.findIndex((column) =>
    PRIMARY_TYPES.has(column.fieldType),
  );
  // A base held in a source creates its tables there (ADR 0090).
  const home = await db
    .selectFrom("bases")
    .select(["homeSourceId", "homeSchema"])
    .where("id", "=", input.baseId)
    .executeTakeFirst();
  if (home?.homeSourceId && home.homeSchema) {
    const { createHostedTable } = await import("../sources/host-table.js");
    try {
      return await createHostedTable(db, userId, {
        baseId: input.baseId,
        name: input.name,
        ...(input.description === undefined
          ? {}
          : { description: input.description }),
        ...(input.viewName === undefined ? {} : { viewName: input.viewName }),
        fields: planned,
        primaryIndex,
        sourceId: home.homeSourceId,
        schema: home.homeSchema,
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new AppError("table_already_exists", { cause: error });
      }
      throw error;
    }
  }
  try {
    return await withAudit(db, { userId, source: "web" }, async (tx) => {
      const counted = await tx
        .selectFrom("dataTables")
        .select(sqlTag<number>`count(*)::int`.as("count"))
        .where("baseId", "=", input.baseId)
        .where("folderId", "is", null)
        .where(liveTable())
        .executeTakeFirst();
      const table = await tx
        .insertInto("dataTables")
        .values({
          baseId: input.baseId,
          name: input.name,
          physicalName,
          description: input.description ?? null,
          position: counted?.count ?? 0,
          folderId: null,
        })
        .returningAll()
        .executeTakeFirst();
      if (!table) {
        throw new AppError("no_row");
      }
      if (planned.length > 0) {
        await tx
          .insertInto("dataColumns")
          .values(
            planned.map((column, index) => ({
              tableId: table.id,
              name: column.name,
              physicalName: column.name,
              fieldType: column.fieldType,
              requireReason: column.requireReason,
              required: column.required,
              config: column.config,
              label: column.label,
              description: column.description,
              position: index,
              isPrimary: index === primaryIndex,
              isUnique: column.unique,
            })),
          )
          .execute();
      }
      await tx
        .insertInto("views")
        .values({
          tableId: table.id,
          name: input.viewName ?? madeNames().grid,
          viewType: "grid",
          config: {},
          position: 0,
        })
        .execute();
      for (const statement of buildCreateTable({
        table: physicalName,
        columns: planned,
      })) {
        await runRows(tx, statement);
      }
      await createPhysicalColumns(tx, table, planned);
      return { id: table.id };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new AppError("table_already_exists", { cause: error });
    }
    throw error;
  }
}

export async function updateTable(
  db: Database,
  userId: string,
  input: {
    tableId: string;
    name?: string;
    description?: string | null;
    trailReads?: boolean;
  },
  source = "web",
): Promise<void> {
  const changes = {
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.description !== undefined
      ? { description: input.description }
      : {}),
    ...(input.trailReads !== undefined ? { trailReads: input.trailReads } : {}),
  };
  if (Object.keys(changes).length === 0) return;
  try {
    await withAudit(
      db,
      { userId, tableId: input.tableId, source },
      async (tx) => {
        await tx
          .updateTable("dataTables")
          .set(changes)
          .where("id", "=", input.tableId)
          .execute();
      },
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new AppError("table_already_exists", { cause: error });
    }
    throw error;
  }
}

/** Reorders tables at the root of the base (not inside a folder). */
export async function reorderTables(
  db: Database,
  userId: string,
  baseId: string,
  order: readonly string[],
): Promise<void> {
  const existing = await db
    .selectFrom("dataTables")
    .select("id")
    .where("baseId", "=", baseId)
    .where("folderId", "is", null)
    .where(liveTable())
    .execute();
  const ids = new Set(existing.map((row) => row.id));
  if (order.length !== ids.size || order.some((id) => !ids.has(id))) {
    throw new AppError("invalid_order");
  }
  await withAudit(db, { userId, source: "web" }, async (tx) => {
    for (const [index, id] of order.entries()) {
      await tx
        .updateTable("dataTables")
        .set({ position: index })
        .where("id", "=", id)
        .execute();
    }
  });
}

async function tableRows(
  db: Database,
  tableId: string,
): Promise<{ table: TableRow; rows: CatalogRows }> {
  const rows = await loadCatalogRows(db, [tableId]);
  const table = rows.tables.find((item) => item.id === tableId);
  if (!table) {
    throw new AppError("unknown_table");
  }
  return { table, rows };
}

export function ownColumns(rows: CatalogRows, tableId: string): ColumnRow[] {
  return sortColumns(
    rows.columns.filter((column) => column.tableId === tableId),
  );
}

async function shiftPositions(
  tx: AuditTx,
  tableId: string,
  from: number,
): Promise<void> {
  await tx
    .updateTable("dataColumns")
    .set((eb) => ({ position: eb("position", "+", 1) }))
    .where("tableId", "=", tableId)
    .where("position", ">=", from)
    .execute();
}

export async function addColumn(
  db: Database,
  userId: string,
  tableId: string,
  definition: ColumnDefinition,
  position?: number,
): Promise<{ id: string; name: string }> {
  const { table, rows } = await tableRows(db, tableId);
  const existing = ownColumns(rows, table.id);
  if (existing.length >= 500) {
    throw new AppError("invalid_column_count");
  }
  const planned = planColumn(
    definition,
    existing,
    await trashedColumnNames(db, table.id),
  );
  // AnyGridDB never changes a client's table: on one, a field that stores
  // something lives in the side table (ADR 0032); a formula, a button, or
  // the row's id stores nothing. A table this product created in a schema
  // it owns is the exception: the new column is a column of that table.
  if (isHomeTable(table)) {
    if (planned.fieldType === "formula") {
      assertCompiles(
        withPlanned(rows, table, [planned], existing.length),
        table.id,
        planned.name,
      );
    }
    const { addHostedColumn } = await import("../sources/host-table.js");
    return addHostedColumn(
      db,
      userId,
      table,
      planned,
      position === undefined
        ? existing.length
        : Math.min(position, existing.length),
    );
  }
  if (
    table.storage === "external" &&
    planned.fieldType !== "formula" &&
    planned.fieldType !== "button" &&
    planned.fieldType !== "row_id"
  ) {
    if (!isSideFieldType(planned.fieldType)) {
      throw new AppError("external_table_schema");
    }
    return addSideField(
      db,
      userId,
      table,
      {
        name: planned.name,
        label: planned.label,
        description: planned.description ?? null,
        fieldType: planned.fieldType,
        config: planned.config,
        requireReason: planned.requireReason,
      },
      position === undefined
        ? existing.length
        : Math.min(position, existing.length),
    );
  }
  if (planned.fieldType === "formula") {
    assertCompiles(
      withPlanned(rows, table, [planned], existing.length),
      table.id,
      planned.name,
    );
  }
  const at =
    position === undefined
      ? existing.length
      : Math.min(position, existing.length);
  try {
    return await withAudit(
      db,
      { userId, tableId: table.id, source: "web" },
      async (tx) => {
        await shiftPositions(tx, table.id, at);
        const inserted = await tx
          .insertInto("dataColumns")
          .values({
            tableId: table.id,
            name: planned.name,
            physicalName: planned.name,
            fieldType: planned.fieldType,
            requireReason: planned.requireReason,
            required: planned.required,
            config: planned.config as Record<string, unknown>,
            label: planned.label,
            description: planned.description,
            position: at,
            isPrimary:
              !existing.some((column) => column.isPrimary) &&
              PRIMARY_TYPES.has(planned.fieldType),
            isUnique: planned.unique,
          })
          .returning("id")
          .executeTakeFirst();
        const id = inserted?.id;
        if (!id) {
          throw new AppError("no_row");
        }
        if (isWritableType(planned.fieldType)) {
          await runRows(
            tx,
            buildAddColumn({
              table: table.physicalName,
              column: planned,
              defaultValue: defaultLiteral(planned),
            }),
          );
          if (planned.fieldType === "attachment") {
            await runRows(
              tx,
              buildFileIndex({
                table: table.physicalName,
                column: planned.name,
              }),
            );
          }
          if (planned.unique) {
            await runRows(
              tx,
              buildUniqueIndex({
                table: table.physicalName,
                column: planned.name,
              }),
            );
          }
        }
        return { id, name: planned.name };
      },
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new AppError("column_already_exists", { cause: error });
    }
    throw error;
  }
}

/** Columns in the base that would break if `name` on `tableId` went away. */
export function dependents(
  rows: CatalogRows,
  tableId: string,
  column: ColumnRow,
): ColumnRow[] {
  const relationsInto = new Set(
    rows.relations
      .filter((relation) => relation.toTableId === tableId)
      .map((relation) => relation.fromColumnId),
  );
  return rows.columns.filter((other) => {
    if (other.id === column.id) {
      return false;
    }
    const config = columnConfig(other);
    if (other.tableId === tableId) {
      if (config.expr && formulaReferences(config.expr).includes(column.name))
        return true;
      if (config.relation === column.name) return true;
      if (config.inverseOf === column.id) return false;
    }
    if (other.fieldType === "lookup" || other.fieldType === "rollup") {
      const relationColumn = rows.columns.find(
        (item) =>
          item.tableId === other.tableId && item.name === config.relation,
      );
      if (
        relationColumn &&
        relationsInto.has(relationColumn.id) &&
        config.target === column.name
      ) {
        return true;
      }
    }
    return false;
  });
}

export async function loadBaseRows(
  db: Database,
  baseId: string,
): Promise<CatalogRows> {
  const ids = (
    await db
      .selectFrom("dataTables")
      .select("id")
      .where("baseId", "=", baseId)
      .where(liveTable())
      .execute()
  ).map((row) => row.id);
  return loadCatalogRows(db, ids);
}

async function cleanViews(
  tx: AuditTx,
  tableId: string,
  name: string,
): Promise<void> {
  const rows = await tx
    .selectFrom("views")
    .selectAll()
    .where("tableId", "=", tableId)
    .execute();
  for (const view of rows) {
    const next = stripColumnFromConfig(
      normalizeViewConfig(view.config, view.viewType),
      name,
    );
    await tx
      .updateTable("views")
      .set({ config: next as Record<string, unknown> })
      .where("id", "=", view.id)
      .execute();
  }
}

/**
 * Drops a field in the trash for good: its storage, the other side of a
 * two-way link, and every reference views make to it. Attachment cells
 * are read first so their files can be deleted afterwards.
 */
export async function purgeColumn(
  db: Database,
  userId: string,
  columnId: string,
): Promise<{ attachmentKeys: string[] }> {
  const column = await db
    .selectFrom("dataColumns")
    .selectAll()
    .where("id", "=", columnId)
    .where("deletedAt", "is not", null)
    .executeTakeFirst();
  if (!column) {
    throw new AppError("no_row");
  }
  const table = await db
    .selectFrom("dataTables")
    .selectAll()
    .where("id", "=", column.tableId)
    .executeTakeFirst();
  if (!table) {
    throw new AppError("no_row");
  }
  const relation = await db
    .selectFrom("relations")
    .selectAll()
    .where("fromColumnId", "=", column.id)
    .executeTakeFirst();
  const config = columnConfig(column);
  const inverse =
    relation?.inverseColumnId && !config.inverseOf
      ? await db
          .selectFrom("dataColumns")
          .selectAll()
          .where("id", "=", relation.inverseColumnId)
          .executeTakeFirst()
      : undefined;
  const attachmentKeys =
    column.fieldType === "attachment" && table.storage === "native"
      ? await columnAttachmentKeys(db, table.physicalName, [column.name])
      : [];
  // A client's table has no column of AnyGridDB to drop: forgetting the
  // field is all a purge does there.
  const native = table.storage === "native";
  await withAudit(
    db,
    { userId, tableId: table.id, source: "trash" },
    async (tx) => {
      if (relation && !config.inverseOf) {
        if (relation.junctionName) {
          await runRows(tx, buildDropTable(relation.junctionName));
        } else if (column.fieldType === "relation_one_to_many" && native) {
          await runRows(
            tx,
            buildDropColumn({ table: table.physicalName, column: column.name }),
          );
        }
        if (inverse) {
          await tx
            .deleteFrom("dataColumns")
            .where("id", "=", inverse.id)
            .execute();
          await cleanViews(tx, inverse.tableId, inverse.name);
        }
      } else if (relation && config.inverseOf) {
        await tx
          .updateTable("relations")
          .set({ inverseColumnId: null })
          .where("fromColumnId", "=", config.inverseOf)
          .execute();
      } else if (hasPhysicalColumn(column.fieldType) && native) {
        await runRows(
          tx,
          buildDropColumn({ table: table.physicalName, column: column.name }),
        );
      }
      await tx.deleteFrom("dataColumns").where("id", "=", column.id).execute();
      await cleanViews(tx, table.id, column.name);
    },
  );
  return { attachmentKeys };
}

export async function reorderColumns(
  db: Database,
  userId: string,
  tableId: string,
  order: readonly string[],
): Promise<void> {
  const existing = await db
    .selectFrom("dataColumns")
    .select(["id", "name"])
    .where("tableId", "=", tableId)
    .where(liveColumn())
    .execute();
  const byName = new Map(existing.map((column) => [column.name, column.id]));
  if (order.length !== byName.size || order.some((name) => !byName.has(name))) {
    throw new AppError("invalid_order");
  }
  await withAudit(db, { userId, tableId, source: "web" }, async (tx) => {
    for (const [index, name] of order.entries()) {
      const id = byName.get(name);
      if (id) {
        await tx
          .updateTable("dataColumns")
          .set({ position: index })
          .where("id", "=", id)
          .execute();
      }
    }
  });
}

export async function setPrimaryColumn(
  db: Database,
  userId: string,
  tableId: string,
  name: string,
): Promise<void> {
  const existing = await db
    .selectFrom("dataColumns")
    .selectAll()
    .where("tableId", "=", tableId)
    .where(liveColumn())
    .execute();
  const column = existing.find((item) => item.name === name);
  if (!column) {
    throw new AppError("unknown_column", name);
  }
  if (!PRIMARY_TYPES.has(column.fieldType)) {
    throw new AppError("invalid_column");
  }
  // A row's label is read in the client's query, which a field kept in
  // AnyGridDB's database is not in (ADR 0046).
  if (column.externalControlPlane) {
    throw new AppError("control_plane_formula", column.label);
  }
  await withAudit(db, { userId, tableId, source: "web" }, async (tx) => {
    await tx
      .updateTable("dataColumns")
      .set({ isPrimary: false })
      .where("tableId", "=", tableId)
      .execute();
    await tx
      .updateTable("dataColumns")
      .set({ isPrimary: true })
      .where("id", "=", column.id)
      .execute();
  });
}

export type ColumnUpdate = {
  name: string;
  label?: string;
  description?: string | null;
  requireReason?: boolean;
  required?: boolean;
  unique?: boolean;
  fieldType?: FieldType;
  config?: Record<string, unknown>;
  formulaSource?: string;
  reason?: string;
  optionRenames?: ReadonlyArray<{ from: string; to: string }>;
  /** Where a day and an instant meet: the zone of the person converting. */
  timeZone?: string;
};

/** Past this many rows a conversion runs in the background, by batches. */
const CONVERSION_JOB_ROWS = 20_000;
/** The most values a preview reads: past them, it says what it saw. */
const PREVIEW_VALUES = 100_000;
const MAX_OPTIONS = ceilingOf("conversion.options_added");

/** The options a list field takes from the values it is converted from. */
async function conversionOptions(
  db: Database | Tx,
  table: TableRow,
  column: ColumnRow,
  fieldType: FieldType,
): Promise<string[]> {
  const result = await runStatement(
    db,
    buildConversionOptions({
      table: table.physicalName,
      column: column.name,
      from: column.fieldType,
      to: fieldType,
      limit: MAX_OPTIONS,
    }),
  );
  return result.flatMap((row) =>
    typeof row.value === "string" ? [row.value] : [],
  );
}

/** The settings of the type a field is converted to, its options settled. */
async function convertedConfig(
  db: Database | Tx,
  table: TableRow,
  column: ColumnRow,
  fieldType: FieldType,
  raw: Record<string, unknown>,
): Promise<ColumnConfig> {
  const next = { ...raw };
  if (
    (fieldType === "single_select" || fieldType === "multi_select") &&
    next.options === undefined
  ) {
    const fromCurrent = columnConfig(column).options ?? [];
    const names =
      fromCurrent.length > 0
        ? []
        : await conversionOptions(db, table, column, fieldType);
    next.options =
      fromCurrent.length > 0
        ? fromCurrent
        : (names.length > 0 ? names : ["Option 1"]).map((name, index) => ({
            name,
            color: OPTION_COLORS[index % OPTION_COLORS.length],
          }));
  }
  return parseColumnConfig(fieldType, next);
}

/** A conversion of this kind waits for no one: it refuses a zone it cannot use. */
function assertConversionZone(
  from: FieldType,
  to: FieldType,
  timeZone: string | undefined,
): void {
  if (timeZone !== undefined && !isTimeZone(timeZone)) {
    throw new AppError("invalid_time_zone");
  }
  if (timeZone === undefined && conversionZone(from, to) === "required") {
    throw new AppError("conversion_needs_time_zone");
  }
}

/** Whether a job is converting one of this table's fields, or waits to. */
export async function conversionRunning(
  db: Database,
  tableId: string,
  except?: string,
): Promise<boolean> {
  let query = db
    .selectFrom("jobs")
    .select("id")
    .where("kind", "=", "convert_column")
    .where("tableId", "=", tableId)
    .where("status", "in", ["queued", "running"]);
  if (except) query = query.where("id", "!=", except);
  return (await query.executeTakeFirst()) !== undefined;
}

/** Whether a conversion of this table is long enough for the background. */
async function isLongConversion(
  db: Database,
  table: TableRow,
  from: FieldType,
  to: FieldType,
): Promise<boolean> {
  if (from === to || isMetadataConversion(from, to)) return false;
  if (!hasPhysicalColumn(from) || !isWritableType(to)) return false;
  const [row] = await runStatement(
    db,
    buildCountRowsUpTo(table.physicalName, CONVERSION_JOB_ROWS + 1),
  );
  return Number(row?.count ?? 0) > CONVERSION_JOB_ROWS;
}

/**
 * The change of a field as a background job would run it, its options
 * settled, when it is long enough for one; undefined otherwise.
 */
export async function planLongConversion(
  db: Database,
  table: TableRow,
  input: ColumnUpdate,
): Promise<ColumnUpdate | undefined> {
  if (input.fieldType === undefined || table.storage === "external") {
    return undefined;
  }
  const column = await db
    .selectFrom("dataColumns")
    .select("fieldType")
    .where("tableId", "=", table.id)
    .where("name", "=", input.name)
    .where(liveColumn())
    .executeTakeFirst();
  if (
    !column ||
    !isConvertible(column.fieldType, input.fieldType) ||
    !(await isLongConversion(db, table, column.fieldType, input.fieldType))
  ) {
    return undefined;
  }
  await planColumnUpdate(db, table, input);
  return input;
}

/** What a change of a field was checked to be, ready to apply. */
export type ColumnPlan = {
  column: ColumnRow;
  own: ColumnRow[];
  fieldType: FieldType;
  converting: boolean;
  config: ColumnConfig;
  unique: boolean;
  renames: ReadonlyArray<{ from: string; to: string }>;
  /** What was asked of the settings: options left out come from the values. */
  asked: Record<string, unknown>;
};

/**
 * Checks a change of a field against the catalog and the rows, and settles
 * what it will write. Changes nothing. `job` is the conversion running this
 * change, which does not stand in its own way.
 */
export async function planColumnUpdate(
  db: Database,
  table: TableRow,
  input: ColumnUpdate,
  job?: string,
): Promise<ColumnPlan> {
  const rows = await loadBaseRows(db, table.baseId);
  const own = ownColumns(rows, table.id);
  const column = own.find((item) => item.name === input.name);
  if (!column) {
    throw new AppError("unknown_column", input.name);
  }
  if (input.label !== undefined) {
    assertUniqueLabel(
      own.filter((item) => item.id !== column.id),
      input.label,
    );
  }
  // Its fields stay as they are until a running conversion has switched.
  if (await conversionRunning(db, table.id, job)) {
    throw new AppError("table_converting");
  }
  const fieldType = input.fieldType ?? column.fieldType;
  const converting = fieldType !== column.fieldType;
  // A client's column keeps the type and constraints its database gives.
  if (
    table.storage === "external" &&
    column.externalType !== null &&
    (converting || input.unique !== undefined)
  ) {
    throw new AppError("external_table_schema");
  }
  if (converting) {
    const metadataOnly = isMetadataConversion(column.fieldType, fieldType);
    if (!metadataOnly && !isConvertible(column.fieldType, fieldType)) {
      throw new AppError("invalid_conversion");
    }
    assertConversionZone(column.fieldType, fieldType, input.timeZone);
    // Every table keeps a field that names its rows.
    if (
      column.isPrimary &&
      !PRIMARY_TYPES.has(fieldType) &&
      !own.some(
        (item) => item.id !== column.id && PRIMARY_TYPES.has(item.fieldType),
      )
    ) {
      throw new AppError("primary_field_needed");
    }
  }
  const current = columnConfig(column);
  const raw: Record<string, unknown> =
    input.config !== undefined
      ? { ...input.config }
      : converting
        ? {}
        : { ...current };
  if (fieldType === "formula") {
    const refs = own.map((item) => ({ name: item.name, label: item.label }));
    if (input.formulaSource) {
      raw.expr = parseFormula(input.formulaSource, refs);
    } else if (raw.expr === undefined) {
      raw.expr = current.expr;
    }
  }
  if (fieldType === "lookup" || fieldType === "rollup") {
    raw.relation ??= current.relation;
    raw.target ??= current.target;
    if (fieldType === "rollup") raw.fn ??= current.fn;
  }
  if (isRelationType(fieldType) && current.inverseOf) {
    raw.inverseOf = current.inverseOf;
  }
  const config = converting
    ? await convertedConfig(db, table, column, fieldType, raw)
    : parseColumnConfig(fieldType, {
        ...raw,
        ...((fieldType === "single_select" || fieldType === "multi_select") &&
        raw.options === undefined
          ? {
              options:
                (current.options ?? []).length > 0
                  ? current.options
                  : [{ name: "Option 1", color: OPTION_COLORS[0] }],
            }
          : {}),
      });
  // A selection names a shared view of the linked table, or a filter on it.
  if (isRelationType(fieldType) && config.selectFrom) {
    const engine = assembleEngine(table.id, rows, () => true);
    const relation = engine.table.columns.find(
      (item) => item.name === column.name,
    )?.relation;
    const target = relation
      ? engine.tables.get(relation.targetTableId)
      : undefined;
    if (!target) throw new AppError("invalid_relation");
    await assertSelectionConfig(
      db,
      { ...engine, table: target },
      config.selectFrom,
    );
  }
  const unique =
    input.unique ??
    (converting
      ? column.isUnique && UNIQUE_TYPES.has(fieldType)
      : column.isUnique);
  if (unique && !UNIQUE_TYPES.has(fieldType)) {
    throw new AppError("invalid_column");
  }
  // A rollup's function must suit its target, as when it was added.
  if (fieldType === "rollup" && config.fn && config.relation && config.target) {
    const engine = assembleEngine(table.id, rows, () => true);
    const relation = engine.table.columns.find(
      (item) => item.name === config.relation,
    )?.relation;
    const target = relation
      ? engine.tables
          .get(relation.targetTableId)
          ?.columns.find((item) => item.name === config.target)
      : undefined;
    if (target && !rollupFitsTarget(config.fn, target.fieldType)) {
      throw new AppError("invalid_formula");
    }
  }
  if (
    fieldType === "formula" ||
    fieldType === "lookup" ||
    fieldType === "rollup"
  ) {
    const trial: CatalogRows = {
      ...rows,
      columns: rows.columns.map((item) =>
        item.id === column.id ? { ...item, fieldType, config: config } : item,
      ),
    };
    assertCompiles(trial, table.id, column.name);
  }
  if (
    converting &&
    hasPhysicalColumn(column.fieldType) &&
    !isMetadataConversion(column.fieldType, fieldType)
  ) {
    const locked = buildCountLocked(table.physicalName);
    const lockedCount = Number((await runStatement(db, locked))[0]?.count ?? 0);
    if (lockedCount > 0) {
      throw new AppError("row_locked");
    }
  }
  if (unique && !column.isUnique) {
    const duplicates = buildCountDuplicates({
      table: table.physicalName,
      column: column.name,
    });
    const count = Number((await runStatement(db, duplicates))[0]?.count ?? 0);
    if (count > 0) {
      throw new AppError("duplicate_values");
    }
  }
  const renames = input.optionRenames ?? [];
  const names = new Set((config.options ?? []).map((option) => option.name));
  for (const rename of renames) {
    if (!names.has(rename.to)) {
      throw new AppError("invalid_option");
    }
  }
  return {
    column,
    own,
    fieldType,
    converting,
    config,
    unique,
    renames,
    asked: raw,
  };
}

/**
 * Writes a planned change in one transaction. `filled`: a job has already
 * written the converted values beside the field, and this is its switch.
 */
export async function applyColumnUpdate(
  db: Database,
  userId: string,
  table: TableRow,
  input: ColumnUpdate,
  plan: ColumnPlan,
  source = "web",
  filled = false,
): Promise<void> {
  const { column, own, fieldType, converting, unique, renames } = plan;
  let { config } = plan;
  await withAudit(
    db,
    { userId, tableId: table.id, reason: input.reason ?? null, source },
    async (tx) => {
      // The switch waits briefly for the table, and is tried again: a long
      // wait here would hold every reader behind it.
      if (filled) await sqlTag`set local lock_timeout = '3s'`.execute(tx);
      const rewrites =
        converting &&
        hasPhysicalColumn(column.fieldType) &&
        isWritableType(fieldType) &&
        !isMetadataConversion(column.fieldType, fieldType);
      // No write lands between the values read here and the new type.
      if (rewrites && !filled) {
        await runRows(tx, buildLockOutWriters(table.physicalName));
      }
      if (column.isUnique && (!unique || converting)) {
        await runRows(
          tx,
          buildDropUniqueIndex({
            table: table.physicalName,
            column: column.name,
          }),
        );
      }
      // Under the names the rows hold now, before they are read for a type.
      for (const rename of renames) {
        if (
          column.fieldType === "single_select" ||
          column.fieldType === "multi_select"
        ) {
          await runRows(
            tx,
            buildRenameOption({
              table: table.physicalName,
              column: column.name,
              multiple: column.fieldType === "multi_select",
              from: rename.from,
              to: rename.to,
            }),
          );
        }
      }
      if (rewrites && filled) {
        for (const statement of buildConversionSwitch({
          table: table.physicalName,
          column: column.name,
        }))
          await runRows(tx, statement);
      } else if (rewrites) {
        config = await convertedConfig(
          tx,
          table,
          column,
          fieldType,
          plan.asked,
        );
        const beside = !isStoredAlike(column.fieldType, fieldType);
        if (beside) {
          await runRows(
            tx,
            buildConversionTempColumn({
              table: table.physicalName,
              column: column.name,
              to: fieldType,
            }),
          );
        }
        await rewriteField(
          tx,
          {
            table: table.physicalName,
            column: column.name,
            from: column.fieldType,
            to: fieldType,
            config,
            timeZone: input.timeZone,
          },
          beside,
        );
        if (beside) {
          for (const statement of buildConversionSwitch({
            table: table.physicalName,
            column: column.name,
          }))
            await runRows(tx, statement);
        }
      }
      if (isWritableType(fieldType) && hasPhysicalColumn(column.fieldType)) {
        const fallback = config.defaultValue;
        await runRows(
          tx,
          buildSetDefault({
            table: table.physicalName,
            column: { name: column.name, fieldType },
            defaultValue: fallback ?? null,
          }),
        );
      }
      if (unique && (!column.isUnique || converting)) {
        await runRows(
          tx,
          filled
            ? buildRenameConversionIndex({
                table: table.physicalName,
                column: column.name,
              })
            : buildUniqueIndex({
                table: table.physicalName,
                column: column.name,
              }),
        );
      }
      await tx
        .updateTable("dataColumns")
        .set({
          fieldType,
          config: config as Record<string, unknown>,
          isUnique: unique,
          ...(input.label !== undefined ? { label: input.label } : {}),
          ...(input.description !== undefined
            ? { description: input.description }
            : {}),
          ...(input.requireReason !== undefined
            ? {
                requireReason: input.requireReason && isWritableType(fieldType),
              }
            : {}),
          // A client's table says itself what it requires; a type that
          // cannot be required drops the rule.
          required:
            (input.required ?? column.required) &&
            canBeRequired(fieldType) &&
            table.sourceId === null,
        })
        .where("id", "=", column.id)
        .execute();
      if (column.isPrimary && !PRIMARY_TYPES.has(fieldType)) {
        await tx
          .updateTable("dataColumns")
          .set({ isPrimary: false })
          .where("id", "=", column.id)
          .execute();
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
}

export async function updateColumn(
  db: Database,
  userId: string,
  table: TableRow,
  input: ColumnUpdate,
  source = "web",
): Promise<void> {
  try {
    const plan = await planColumnUpdate(db, table, input);
    await applyColumnUpdate(db, userId, table, input, plan, source);
  } catch (error) {
    // Past the pool's limit for a statement: the table is left as it was.
    if (input.fieldType !== undefined && postgresCode(error) === "57014") {
      throw new AppError("conversion_too_large", { cause: error });
    }
    throw error;
  }
}

/** What stops working once a field has its new type. */
function brokenByConversion(
  rows: CatalogRows,
  table: TableRow,
  column: ColumnRow,
  fieldType: FieldType,
  config: ColumnConfig,
  views: ReadonlyArray<{
    id: string;
    name: string;
    viewType: string;
    config: unknown;
  }>,
  canRead: (tableId: string) => boolean,
): {
  views: Array<{ id: string; name: string }>;
  fields: Array<{ tableId: string; name: string; label: string }>;
  /** Fields that stop too, in tables the person asking may not read. */
  fieldsElsewhere: number;
} {
  const after: CatalogRows = {
    ...rows,
    columns: rows.columns.map((item) =>
      item.id === column.id ? { ...item, fieldType, config } : item,
    ),
  };
  const fields: Array<{ tableId: string; name: string; label: string }> = [];
  let fieldsElsewhere = 0;
  const computed = rows.columns.filter(
    (item) =>
      item.fieldType === "formula" ||
      item.fieldType === "lookup" ||
      item.fieldType === "rollup",
  );
  for (const tableId of new Set(computed.map((item) => item.tableId))) {
    const failing = (catalog: CatalogRows) =>
      new Set(
        describeColumns(assembleEngine(tableId, catalog, () => true))
          .filter((item) => item.error)
          .map((item) => item.name),
      );
    const before = failing(rows);
    const now = failing(after);
    for (const item of computed) {
      if (
        item.tableId === tableId &&
        now.has(item.name) &&
        !before.has(item.name)
      ) {
        // Named only to who may read its table; counted for anyone else.
        if (canRead(tableId)) {
          fields.push({ tableId, name: item.name, label: item.label });
        } else {
          fieldsElsewhere += 1;
        }
      }
    }
  }
  const engine = assembleEngine(table.id, after, () => true);
  const known = new Set(engine.table.columns.map((item) => item.name));
  const broken = views.filter((view) => {
    const filter = viewFilter(
      pruneViewConfig(
        normalizeViewConfig(view.config, view.viewType as never),
        known,
      ),
    );
    if (!filter) return false;
    try {
      buildReadRows(engine, { filter, limit: 1 });
      return false;
    } catch (error) {
      if (
        error instanceof AppError &&
        (error.code === "invalid_filter" || error.code === "not_comparable")
      ) {
        return true;
      }
      throw error;
    }
  });
  return {
    views: broken.map((view) => ({ id: view.id, name: view.name })),
    fields,
    fieldsElsewhere,
  };
}

/**
 * What a conversion would do, before anything changes: the values it
 * keeps, empties and writes differently, a few examples, the zone it reads
 * days in, what stops working, and whether it runs in the background.
 */
export async function previewConversion(
  db: Database,
  table: TableRow,
  name: string,
  fieldType: FieldType,
  asked: {
    config?: Record<string, unknown>;
    timeZone?: string;
    /** Who asks: another person's own views and unread tables stay unnamed. */
    viewer: { userId: string; canRead: (tableId: string) => boolean };
  },
): Promise<{
  total: number;
  lost: number;
  rewritten: number;
  /** Counted on the first values only: the table holds more. */
  sampled: boolean;
  samples: Array<{ before: unknown; after: unknown }>;
  timeZone: string | null;
  background: boolean;
  views: Array<{ id: string; name: string }>;
  fields: Array<{ tableId: string; name: string; label: string }>;
  fieldsElsewhere: number;
}> {
  const rows = await loadBaseRows(db, table.baseId);
  const column = ownColumns(rows, table.id).find((item) => item.name === name);
  if (!column) {
    throw new AppError("unknown_column", name);
  }
  const metadata = isMetadataConversion(column.fieldType, fieldType);
  if (!metadata && !isConvertible(column.fieldType, fieldType)) {
    throw new AppError("invalid_conversion");
  }
  assertConversionZone(column.fieldType, fieldType, asked.timeZone);
  const config = await convertedConfig(
    db,
    table,
    column,
    fieldType,
    asked.config ?? {},
  );
  const views = await db
    .selectFrom("views")
    .select(["id", "name", "viewType", "config"])
    .where("tableId", "=", table.id)
    .where((eb) =>
      eb.or([
        eb("ownerId", "is", null),
        eb("ownerId", "=", asked.viewer.userId),
      ]),
    )
    .execute();
  const broken = brokenByConversion(
    rows,
    table,
    column,
    fieldType,
    config,
    views,
    asked.viewer.canRead,
  );
  // A field with a zone of its own reads its days there.
  const ownZone = (config as { date?: { timeZone?: string } }).date?.timeZone;
  const zone =
    conversionZone(column.fieldType, fieldType) === "none"
      ? null
      : (ownZone ?? asked.timeZone ?? null);
  if (metadata) {
    return {
      total: 0,
      lost: 0,
      rewritten: 0,
      sampled: false,
      samples: [],
      timeZone: null,
      background: false,
      ...broken,
    };
  }
  const counted = await tallyConversion(
    db,
    {
      table: table.physicalName,
      column: column.name,
      from: column.fieldType,
      to: fieldType,
      config,
      timeZone: asked.timeZone,
    },
    PREVIEW_VALUES,
  );
  return {
    ...counted,
    sampled: counted.total >= PREVIEW_VALUES,
    timeZone: zone,
    background: await isLongConversion(db, table, column.fieldType, fieldType),
    ...broken,
  };
}
