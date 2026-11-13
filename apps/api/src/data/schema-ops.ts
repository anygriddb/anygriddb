import { randomBytes } from "node:crypto";
import {
  isSideFieldType,
  AppError,
  buildAddColumn,
  buildConversionPreview,
  buildConversionStatements,
  buildCountDuplicates,
  buildCountLocked,
  buildCreateTable,
  buildDistinctText,
  buildDropColumn,
  buildDropTable,
  buildDropUniqueIndex,
  buildRenameOption,
  buildSetDefault,
  buildUniqueIndex,
  type ColumnConfig,
  type ColumnDefinition,
  deriveColumnName,
  describeColumns,
  type FieldType,
  type FormulaRef,
  formulaReferences,
  hasPhysicalColumn,
  isConvertible,
  isMetadataConversion,
  isRelationType,
  isWritableType,
  canBeRequired,
  madeNames,
  normalizeViewConfig,
  OPTION_COLORS,
  parseColumnConfig,
  PRIMARY_TYPES,
  rollupFitsTarget,
  parseFormula,
  stripColumnFromConfig,
} from "@anygriddb/core";

export { PRIMARY_TYPES };
import { runStatement, type Database } from "@anygriddb/db";
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
import { assertSelectionConfig } from "./link-selection.js";

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

export function physicalTableName(): string {
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
export function planColumn(
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
): Promise<void> {
  await withAudit(db, { userId, source: "web" }, async (tx) => {
    await tx
      .updateTable("bases")
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined
          ? { description: input.description }
          : {}),
      })
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
  input: { tableId: string; name?: string; description?: string | null },
): Promise<void> {
  try {
    await withAudit(
      db,
      { userId, tableId: input.tableId, source: "web" },
      async (tx) => {
        await tx
          .updateTable("dataTables")
          .set({
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.description !== undefined
              ? { description: input.description }
              : {}),
          })
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
  // the row's id stores nothing.
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

export async function cleanViews(
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
};

async function distinctOptions(
  db: Database,
  table: TableRow,
  column: ColumnRow,
): Promise<string[]> {
  const statement = buildDistinctText({
    table: table.physicalName,
    column: column.name,
    arrayColumn: column.fieldType === "multi_select",
    limit: 200,
  });
  const result = await runStatement(db, statement);
  return result.flatMap((row) =>
    typeof row.value === "string" ? [row.value.slice(0, 80)] : [],
  );
}

export async function updateColumn(
  db: Database,
  userId: string,
  table: TableRow,
  input: ColumnUpdate,
): Promise<void> {
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
  if (
    (fieldType === "single_select" || fieldType === "multi_select") &&
    raw.options === undefined
  ) {
    const names = converting ? await distinctOptions(db, table, column) : [];
    const fromCurrent = current.options ?? [];
    raw.options =
      fromCurrent.length > 0
        ? fromCurrent
        : (names.length > 0 ? names : ["Option 1"]).map((name, index) => ({
            name,
            color: OPTION_COLORS[index % OPTION_COLORS.length],
          }));
  }
  const config = parseColumnConfig(fieldType, raw);
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
  await withAudit(
    db,
    { userId, tableId: table.id, reason: input.reason ?? null, source: "web" },
    async (tx) => {
      if (column.isUnique && (!unique || converting)) {
        await runRows(
          tx,
          buildDropUniqueIndex({
            table: table.physicalName,
            column: column.name,
          }),
        );
      }
      if (
        converting &&
        hasPhysicalColumn(column.fieldType) &&
        isWritableType(fieldType)
      ) {
        if (!isMetadataConversion(column.fieldType, fieldType)) {
          const statements = buildConversionStatements({
            table: table.physicalName,
            column: column.name,
            from: column.fieldType,
            to: fieldType,
          });
          for (const statement of statements.prepare)
            await runRows(tx, statement);
          await runRows(tx, statements.rewrite);
          for (const statement of statements.finish)
            await runRows(tx, statement);
        }
      }
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
          buildUniqueIndex({ table: table.physicalName, column: column.name }),
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

/** What a conversion would do to existing values: totals and a few examples. */
export async function previewConversion(
  db: Database,
  table: TableRow,
  name: string,
  fieldType: FieldType,
): Promise<{
  total: number;
  lost: number;
  samples: Array<{ before: unknown; after: unknown }>;
}> {
  const column = await db
    .selectFrom("dataColumns")
    .selectAll()
    .where("tableId", "=", table.id)
    .where("name", "=", name)
    .where(liveColumn())
    .executeTakeFirst();
  if (!column) {
    throw new AppError("unknown_column", name);
  }
  if (isMetadataConversion(column.fieldType, fieldType)) {
    return { total: 0, lost: 0, samples: [] };
  }
  if (!isConvertible(column.fieldType, fieldType)) {
    throw new AppError("invalid_conversion");
  }
  const statement = buildConversionPreview({
    table: table.physicalName,
    column: column.name,
    from: column.fieldType,
    to: fieldType,
  });
  const row: Record<string, unknown> =
    (await runStatement(db, statement))[0] ?? {};
  return {
    total: Number(row.total ?? 0),
    lost: Number(row.lost ?? 0),
    samples: Array.isArray(row.samples)
      ? (row.samples as Array<{ before: unknown; after: unknown }>)
      : [],
  };
}

export async function listBaseTables(
  db: Database,
  baseId: string,
): Promise<TableRow[]> {
  return db
    .selectFrom("dataTables")
    .selectAll()
    .where("baseId", "=", baseId)
    .where(liveTable())
    .orderBy("position", "asc")
    .execute();
}

export async function tablesOfBases(
  db: Database,
  baseIds: readonly string[],
): Promise<TableRow[]> {
  if (baseIds.length === 0) {
    return [];
  }
  return db
    .selectFrom("dataTables")
    .selectAll()
    .where("baseId", "in", [...baseIds])
    .where(liveTable())
    .orderBy("position", "asc")
    .execute();
}
