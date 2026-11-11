import {
  type AggregateItem,
  AppError,
  assertStatusTransition,
  type AuditRole,
  buildAggregates,
  buildCountRows,
  buildDelete,
  buildExistingIds,
  buildGroupCounts,
  buildInsert,
  buildInsertLinks,
  buildReadJunction,
  buildReadRows,
  buildReadStatus,
  buildRestoreRow,
  buildSetStatus,
  buildUpdate,
  cellText,
  type CellValue,
  coerceCellValue,
  detectDelimiter,
  type EngineCatalog,
  isTimeZone,
  isWritableType,
  MAX_READ_LIMIT,
  type ParameterizedSql,
  parseDelimited,
  quoteIdent,
  type ReadSpec,
  toCsv,
  type WriteColumn,
} from "@anygriddb/core";
import { readWithin, runStatement, type Database } from "@anygriddb/db";
import { applyControlPlaneReadSpec } from "../sources/control-plane-read-filter.js";
import { loadEnrichmentValues } from "../sources/enrichment-values.js";
import type { SummaryEvent } from "../queue/jobs.js";
import {
  runRows,
  withAudit,
  type AuditContext,
  type AuditTx,
} from "./audit-context.js";
import { sourcePools } from "../sources/pools.js";

export const READ_TIMEOUT = "15s";

export type RowRecord = Record<string, unknown> & { id: string };

export type WriteContext = {
  userId: string;
  tableId: string;
  physicalName: string;
  baseId: string;
  reason: string | null;
  source: string;
  /** How many automations led to this write. */
  depth?: number;
  /**
   * One event for the whole operation, such as an import, instead of one
   * event per row; false for none at all.
   */
  events?: false | { summary: SummaryEvent };
};

export function writeColumns(engine: EngineCatalog): WriteColumn[] {
  return engine.table.columns
    .filter((column) => isWritableType(column.fieldType))
    .map((column) => ({
      name: column.name,
      fieldType: column.fieldType,
      config: column.config,
    }));
}

export function safeTimeZone(value: string | undefined): string {
  return value && isTimeZone(value) ? value : "UTC";
}

/**
 * Runs read statements in one transaction with a statement timeout: in
 * AnyGridDB's database, or in the client's for an external table, which
 * its source's pool reads read-only.
 */
export async function readTransaction<T>(
  db: Database,
  engine: EngineCatalog,
  body: (
    run: (statement: ParameterizedSql) => Promise<Record<string, unknown>[]>,
  ) => Promise<T>,
): Promise<T> {
  const external = engine.table.external;
  // A synced table's copy is in AnyGridDB's database (ADR 0034).
  if (external && !external.synced) {
    return sourcePools().read(external.sourceId, body);
  }
  return readWithin(db, READ_TIMEOUT, body);
}

export type GroupRow = { keys: unknown[]; depth: number; count: number };

/** Above this many rows by its statistics, a client table's total is estimated. */
export const ESTIMATE_FROM = 10_000;

/**
 * A client table's row count from its engine's statistics: cheap, and
 * close once the engine has analyzed the table. Null when it has none (a
 * view, a table never analyzed).
 */
async function estimateRows(
  db: Database,
  engine: EngineCatalog,
): Promise<number | null> {
  const external = engine.table.external;
  if (!external) return null;
  const values = [external.schema, external.name];
  const text =
    external.dialect === "postgres"
      ? `select c.reltuples::bigint as "rows" from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = $1 and c.relname = $2 and c.relkind in ('r', 'p')`
      : external.dialect === "sqlserver"
        ? `select sum(p.rows) as "rows" from sys.partitions p where p.object_id = object_id(quotename($1) + '.' + quotename($2)) and p.index_id in (0, 1)`
        : external.dialect === "oracle"
          ? `select num_rows as "rows" from all_tables where owner = $1 and table_name = $2`
          : `select table_rows as "rows" from information_schema.tables where table_schema = $1 and table_name = $2 and table_type = 'BASE TABLE'`;
  const [row] = await readTransaction(db, engine, (run) =>
    run({ text, values }),
  );
  const rows = Number(row?.rows ?? Number.NaN);
  return Number.isFinite(rows) && rows >= 0 ? rows : null;
}

/** True when a read keeps every row of its table: no filter, search, or rule. */
function readsEveryRow(engine: EngineCatalog, spec: ReadSpec): boolean {
  return (
    !spec.filter?.conditions.length &&
    !spec.search &&
    !spec.rowIds &&
    !spec.excludeRowIds?.length &&
    !engine.access?.rowFilter(engine.table.id)
  );
}

export async function readPage(
  db: Database,
  engine: EngineCatalog,
  spec: ReadSpec,
  options: { total: boolean; exact?: boolean },
): Promise<{
  rows: RowRecord[];
  total: number | null;
  totalEstimated: boolean;
  groups: GroupRow[];
}> {
  if (engine.table.external) return readExternalPage(db, engine, spec, options);
  const page = buildReadRows(engine, spec);
  const count = options.total ? buildCountRows(engine, spec) : null;
  const grouped = buildGroupCounts(engine, spec);
  return readTransaction(db, engine, async (run) => {
    const rows = (await run(page)) as RowRecord[];
    const total = count ? Number((await run(count))[0]?.total ?? 0) : null;
    const groups = grouped
      ? (await run(grouped)).map((row) => ({
          keys: (spec.groupBy ?? []).map(
            (_, index) => row[`k${index}`] ?? null,
          ),
          depth: Number(row.depth),
          count: Number(row.count),
        }))
      : [];
    return { rows, total, totalEstimated: false, groups };
  });
}

/**
 * Fields AnyGridDB keeps for a client's rows in its own database (ADR
 * 0046), merged into a page read from the client. Only the fields the read
 * asked for, and never one the reader may not see.
 */
async function mergeControlPlane(
  db: Database,
  engine: EngineCatalog,
  rows: RowRecord[],
  fields: readonly string[] | undefined,
): Promise<RowRecord[]> {
  const asked = fields ? new Set(fields) : null;
  const control = engine.table.columns.filter(
    (column) =>
      column.physical?.controlPlane === true &&
      (asked === null || asked.has(column.name)) &&
      !engine.access?.hidden(engine.table.id, column.name),
  );
  if (control.length === 0 || rows.length === 0) return rows;
  const bags = await loadEnrichmentValues(
    db,
    engine.table.id,
    rows.map((row) => row.id),
  );
  return rows.map((row) => {
    const bag = bags.get(row.id);
    if (!bag) return row;
    const next: RowRecord = { ...row };
    for (const column of control) {
      if (Object.hasOwn(bag, column.id)) {
        next[column.name] = bag[column.id];
      }
    }
    return next;
  });
}

/**
 * A page of a client table (ADR 0005). Its count runs apart from the
 * page: a large table read whole shows the total its engine's statistics
 * estimate, and a count that runs past the source's time limit falls back
 * to that estimate rather than failing the page.
 */
async function readExternalPage(
  db: Database,
  engine: EngineCatalog,
  spec: ReadSpec,
  options: { total: boolean; exact?: boolean },
): Promise<{
  rows: RowRecord[];
  total: number | null;
  totalEstimated: boolean;
  groups: GroupRow[];
}> {
  const clientSpec = await applyControlPlaneReadSpec(db, engine, spec);
  if (clientSpec === null) {
    return {
      rows: [],
      total: options.total ? 0 : null,
      totalEstimated: false,
      groups: [],
    };
  }
  const page = buildReadRows(engine, clientSpec);
  const grouped = buildGroupCounts(engine, clientSpec);
  const { rows, groups } = await readTransaction(db, engine, async (run) => ({
    rows: (await run(page)) as RowRecord[],
    groups: grouped
      ? (await run(grouped)).map((row) => ({
          keys: (clientSpec.groupBy ?? []).map(
            (_, index) => row[`k${index}`] ?? null,
          ),
          depth: Number(row.depth),
          count: Number(row.count),
        }))
      : [],
  }));
  const merged = await mergeControlPlane(db, engine, rows, clientSpec.fields);
  if (!options.total)
    return { rows: merged, total: null, totalEstimated: false, groups };
  const estimate = readsEveryRow(engine, clientSpec)
    ? await estimateRows(db, engine)
    : null;
  if (!options.exact && estimate !== null && estimate >= ESTIMATE_FROM) {
    return { rows: merged, total: estimate, totalEstimated: true, groups };
  }
  try {
    const [row] = await readTransaction(db, engine, (run) =>
      run(buildCountRows(engine, clientSpec)),
    );
    return {
      rows: merged,
      total: Number(row?.total ?? 0),
      totalEstimated: false,
      groups,
    };
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== "source_timeout") {
      throw error;
    }
    // At least the rows already seen.
    const seen = (clientSpec.offset ?? 0) + merged.length;
    return {
      rows: merged,
      total: Math.max(estimate ?? 0, seen),
      totalEstimated: true,
      groups,
    };
  }
}

export async function readByIds(
  db: Database,
  engine: EngineCatalog,
  rowIds: readonly string[],
  timeZone: string,
  fields: readonly string[] | undefined = visibleFields(engine),
): Promise<RowRecord[]> {
  const statement = buildReadRows(engine, {
    rowIds,
    limit: Math.min(Math.max(rowIds.length, 1), 1000),
    timeZone,
    ...(fields ? { fields } : {}),
  });
  const rows = await readTransaction(
    db,
    engine,
    async (run) => (await run(statement)) as RowRecord[],
  );
  return mergeControlPlane(db, engine, rows, fields);
}

/**
 * The fields of the engine's table the reader may see, in order, or
 * `requested` unchanged when no field rule applies. Responses leave hidden
 * fields out entirely; the engine compiles them to empty as well.
 */
export function visibleFields(
  engine: EngineCatalog,
  requested?: readonly string[],
): readonly string[] | undefined {
  const access = engine.access;
  if (!access) return requested;
  const names = requested ?? engine.table.columns.map((column) => column.name);
  return names.filter((name) => !access.hidden(engine.table.id, name));
}

/**
 * True when the file `key` sits in an attachment field the reader may see,
 * on a row they may see. Rows are found on the physical table, then counted
 * through the engine so the row rule applies.
 */
export async function attachmentVisible(
  db: Database,
  engine: EngineCatalog,
  key: string,
  /** Only this field, when the caller names one. */
  only?: string,
): Promise<boolean> {
  const access = engine.access;
  const fields = engine.table.columns.filter(
    (column) =>
      column.fieldType === "attachment" &&
      (only === undefined || column.name === only) &&
      !access?.hidden(engine.table.id, column.name),
  );
  if (fields.length === 0) return false;
  const holders = fields
    .map((column) => `${quoteIdent(column.name)} @> array[$1::text]`)
    .join(" or ");
  const found = await runStatement(db, {
    text: `select "id" from ${quoteIdent(engine.table.physicalName)} where ${holders} limit ${MAX_READ_LIMIT}`,
    values: [key],
  });
  const rowIds = found.map((row) => String(row.id));
  if (rowIds.length === 0) return false;
  return readTransaction(db, engine, async (run) => {
    const [row] = await run(buildCountRows(engine, { rowIds }));
    return Number(row?.total ?? 0) > 0;
  });
}

/** True when a field or row rule restricts the reader on the engine's table. */
export function hasRules(engine: EngineCatalog): boolean {
  const access = engine.access;
  if (!access) return false;
  const id = engine.table.id;
  return (
    access.rowFilter(id) !== undefined ||
    engine.table.columns.some(
      (column) =>
        access.hidden(id, column.name) || access.readOnly(id, column.name),
    )
  );
}

/** Refuses a write naming a field the writer may only read, or not see. */
export function assertFieldsWritable(
  engine: EngineCatalog,
  names: Iterable<string>,
): void {
  const access = engine.access;
  if (!access) return;
  const id = engine.table.id;
  for (const name of names) {
    if (access.hidden(id, name) || access.readOnly(id, name)) {
      throw new AppError("access_denied");
    }
  }
}

/** Refuses a change to rows outside the writer's row rule. */
export async function assertRowsInScope(
  db: Database,
  engine: EngineCatalog,
  rowIds: readonly string[],
): Promise<void> {
  if (!engine.access?.rowFilter(engine.table.id)) return;
  const unique = [...new Set(rowIds)];
  await readTransaction(db, engine, async (run) => {
    for (let start = 0; start < unique.length; start += MAX_READ_LIMIT) {
      const chunk = unique.slice(start, start + MAX_READ_LIMIT);
      const [row] = await run(buildCountRows(engine, { rowIds: chunk }));
      if (Number(row?.total ?? 0) !== chunk.length) {
        throw new AppError("access_denied");
      }
    }
  });
}

export async function aggregateRows(
  db: Database,
  engine: EngineCatalog,
  spec: Omit<ReadSpec, "limit">,
  items: readonly AggregateItem[],
): Promise<unknown[]> {
  const clientSpec = engine.table.external
    ? await applyControlPlaneReadSpec(db, engine, { ...spec, limit: 1 })
    : { ...spec, limit: 1 };
  if (clientSpec === null) {
    return items.map(() => null);
  }
  const { limit: _limit, ...withoutLimit } = clientSpec;
  const statement = buildAggregates(engine, withoutLimit, items);
  return readTransaction(db, engine, async (run) => {
    const row = (await run(statement))[0] ?? {};
    return items.map((_, index) => row[`a${index}`] ?? null);
  });
}

/** Ids of everyone with a role on the base or one of its tables. */
export async function baseCollaboratorIds(
  db: Database,
  baseId: string,
): Promise<Set<string>> {
  const tableRows = await db
    .selectFrom("dataTables")
    .select("id")
    .where("baseId", "=", baseId)
    .execute();
  const scopeIds = [baseId, ...tableRows.map((row) => row.id)];
  const rows = await db
    .selectFrom("roleBindings")
    .select("userId")
    .where("scopeId", "in", scopeIds)
    .execute();
  return new Set(rows.map((row) => row.userId));
}

export async function listCollaborators(db: Database, baseId: string) {
  const ids = [...(await baseCollaboratorIds(db, baseId))];
  if (ids.length === 0) {
    return [];
  }
  return db
    .selectFrom("users")
    .select(["id", "displayName"])
    .where("id", "in", ids)
    .execute();
}

async function assertUserValues(
  db: Database,
  baseId: string,
  columns: readonly WriteColumn[],
  rows: ReadonlyArray<Readonly<Record<string, CellValue>>>,
): Promise<void> {
  const userColumns = columns.filter((column) => column.fieldType === "user");
  const ids = new Set<string>();
  for (const values of rows) {
    for (const column of userColumns) {
      const value = values[column.name];
      if (Array.isArray(value)) {
        value.forEach((id) => ids.add(id.toLowerCase()));
      }
    }
  }
  if (ids.size === 0) {
    return;
  }
  const members = await baseCollaboratorIds(db, baseId);
  for (const id of ids) {
    if (!members.has(id)) {
      throw new AppError("invalid_cell");
    }
  }
}

async function lockRow(
  tx: AuditTx,
  physicalName: string,
  rowId: string,
): Promise<string> {
  const rows = await runRows(
    tx,
    buildReadStatus({ table: physicalName, id: rowId }),
  );
  const status = rows[0]?.ag_status;
  if (typeof status !== "string") {
    throw new AppError("no_row");
  }
  return status;
}

function assertWritable(status: string): void {
  if (status === "locked" || status === "signed") {
    throw new AppError("row_locked");
  }
}

function readId(result: readonly Record<string, unknown>[]): string {
  const id = result[0]?.id;
  if (typeof id !== "string") {
    throw new AppError("no_row");
  }
  return id;
}

function auditContext(context: WriteContext): AuditContext {
  return {
    userId: context.userId,
    tableId: context.tableId,
    reason: context.reason,
    source: context.source,
    ...(context.events === false
      ? {}
      : { events: context.events ?? { depth: context.depth ?? 0 } }),
  };
}

export async function insertRows(
  db: Database,
  engine: EngineCatalog,
  context: WriteContext,
  rows: ReadonlyArray<Readonly<Record<string, CellValue>>>,
): Promise<string[]> {
  const columns = writeColumns(engine);
  await assertUserValues(db, context.baseId, columns, rows);
  const statements = rows.map((values) =>
    buildInsert({ table: context.physicalName, columns, values }),
  );
  return withAudit(db, auditContext(context), async (tx) => {
    const ids: string[] = [];
    for (const statement of statements) {
      ids.push(readId(await runRows(tx, statement)));
    }
    return ids;
  });
}

export async function updateRows(
  db: Database,
  engine: EngineCatalog,
  context: WriteContext,
  updates: ReadonlyArray<{
    rowId: string;
    values: Readonly<Record<string, CellValue>>;
  }>,
): Promise<string[]> {
  const columns = writeColumns(engine);
  await assertUserValues(
    db,
    context.baseId,
    columns,
    updates.map((update) => update.values),
  );
  const statements = updates
    .filter((update) => Object.keys(update.values).length > 0)
    .map((update) => ({
      rowId: update.rowId,
      statement: buildUpdate({
        table: context.physicalName,
        columns,
        id: update.rowId,
        values: update.values,
      }),
    }));
  await withAudit(db, auditContext(context), async (tx) => {
    for (const item of statements) {
      assertWritable(await lockRow(tx, context.physicalName, item.rowId));
      readId(await runRows(tx, item.statement));
    }
  });
  return statements.map((item) => item.rowId);
}

/** Marker in a post-delete audit event that carries many-to-many targets. */
const M2M_RESTORE = "__ag_m2m";

/** Links of one row in one junction: the rows on the other side. */
type SavedLinks = {
  junction: string;
  side: "left_id" | "right_id";
  ids: string[];
};

/** True for the internal event that keeps a deleted row's links. */
export function isLinkMarker(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    M2M_RESTORE in value
  );
}

type Junction = {
  junction: string;
  /** Where this table's rows sit in the junction. */
  side: "left_id" | "right_id";
  /** Physical table on the other side. */
  other: string;
};

/**
 * Every junction a row of `tableId` can appear in: its own many-to-many
 * links (left side), and links of any table that point to it (right side),
 * one-way or two-way. Trashed link fields count too: their storage, and
 * the links a restore must bring back, are kept.
 */
async function junctionsOf(db: Database, tableId: string): Promise<Junction[]> {
  const found = await db
    .selectFrom("relations as r")
    .innerJoin("dataColumns as c", "c.id", "r.fromColumnId")
    .select([
      "r.junctionName as junction",
      "c.tableId as fromTable",
      "r.toTableId as toTable",
    ])
    .where("r.kind", "=", "many_to_many")
    .where("r.junctionName", "is not", null)
    .where((eb) =>
      eb.or([eb("c.tableId", "=", tableId), eb("r.toTableId", "=", tableId)]),
    )
    .execute();
  const ids = [
    ...new Set(found.flatMap((row) => [row.fromTable, row.toTable])),
  ];
  const physical = new Map(
    ids.length === 0
      ? []
      : (
          await db
            .selectFrom("dataTables")
            .select(["id", "physicalName"])
            .where("id", "in", ids)
            .execute()
        ).map((row) => [row.id, row.physicalName]),
  );
  const junctions: Junction[] = [];
  for (const row of found) {
    if (!row.junction) continue;
    const left = physical.get(row.toTable);
    const right = physical.get(row.fromTable);
    if (row.fromTable === tableId && left) {
      junctions.push({ junction: row.junction, side: "left_id", other: left });
    }
    if (row.toTable === tableId && right) {
      junctions.push({
        junction: row.junction,
        side: "right_id",
        other: right,
      });
    }
  }
  return junctions;
}

async function readLinks(
  tx: AuditTx,
  junctions: readonly Junction[],
  rowId: string,
): Promise<SavedLinks[]> {
  const saved: SavedLinks[] = [];
  for (const { junction, side } of junctions) {
    const rows = await runRows(
      tx,
      buildReadJunction({ junction, side, id: rowId }),
    );
    const far = side === "left_id" ? "right_id" : "left_id";
    const ids = rows.flatMap((row) =>
      typeof row[far] === "string" ? [row[far]] : [],
    );
    if (ids.length > 0) saved.push({ junction, side, ids });
  }
  return saved;
}

export async function deleteRows(
  db: Database,
  context: WriteContext,
  rowIds: readonly string[],
): Promise<string[]> {
  const junctions = await junctionsOf(db, context.tableId);
  await withAudit(db, auditContext(context), async (tx) => {
    for (const rowId of rowIds) {
      assertWritable(await lockRow(tx, context.physicalName, rowId));
      const m2m = await readLinks(tx, junctions, rowId);
      readId(
        await runRows(
          tx,
          buildDelete({ table: context.physicalName, id: rowId }),
        ),
      );
      // Junction rows cascade with the delete. Keep the other sides, in the
      // same transaction, so the event shares the delete's timestamp.
      if (m2m.length > 0) {
        await tx
          .insertInto("auditEvents")
          .values({
            userId: context.userId,
            action: "update",
            tableId: context.tableId,
            recordId: rowId,
            oldValue: { [M2M_RESTORE]: m2m },
            newValue: { [M2M_RESTORE]: [] },
            reason: context.reason,
            source: context.source,
          })
          .execute();
      }
    }
  });
  return [...rowIds];
}

/** Latest `delete` snapshot of each row, for rows that do not exist now. */
async function deletedSnapshots(
  db: Database,
  context: { tableId: string; physicalName: string },
  rowIds: readonly string[] | null,
  limit: number,
): Promise<
  Array<{
    recordId: string;
    snapshot: Record<string, unknown>;
    deletedAt: string;
    deletedBy: string;
  }>
> {
  if (rowIds?.length === 0) return [];
  let query = db
    .selectFrom("auditEvents as e")
    .innerJoin("users as u", "u.id", "e.userId")
    .select(["e.recordId", "e.oldValue", "e.occurredAt", "u.displayName"])
    .where("e.tableId", "=", context.tableId)
    .where("e.action", "=", "delete");
  if (rowIds) query = query.where("e.recordId", "in", [...rowIds]);
  const events = await query
    .orderBy("e.occurredAt", "desc")
    .limit(rowIds ? rowIds.length * 4 : limit * 4)
    .execute();
  const latest = new Map<string, (typeof events)[number]>();
  for (const event of events) {
    if (event.recordId && !latest.has(event.recordId)) {
      latest.set(event.recordId, event);
    }
  }
  const ids = [...latest.keys()];
  if (ids.length === 0) {
    return [];
  }
  const existing = buildExistingIds({ table: context.physicalName, ids });
  const present = await runStatement(db, existing);
  const alive = new Set(present.map((row) => String(row.id)));
  const result: Array<{
    recordId: string;
    snapshot: Record<string, unknown>;
    deletedAt: string;
    deletedBy: string;
  }> = [];
  for (const [recordId, event] of latest) {
    if (
      alive.has(recordId) ||
      !event.oldValue ||
      typeof event.oldValue !== "object"
    ) {
      continue;
    }
    result.push({
      recordId,
      snapshot: event.oldValue as Record<string, unknown>,
      deletedAt: event.occurredAt.toISOString(),
      deletedBy: event.displayName,
    });
    if (result.length >= limit) {
      break;
    }
  }
  return result;
}

export async function listTrash(
  db: Database,
  engine: EngineCatalog,
  context: { tableId: string; physicalName: string },
  limit: number,
) {
  const primary = engine.table.primaryColumn;
  const deleted = await deletedSnapshots(db, context, null, limit);
  return deleted.map((item) => ({
    rowId: item.recordId,
    label:
      cellText(primary ? item.snapshot[primary] : item.recordId) ||
      item.recordId,
    deletedAt: item.deletedAt,
    deletedBy: item.deletedBy,
  }));
}

/**
 * Links kept when each row was last deleted: the marker written in the
 * same transaction as the delete event, so it shares its timestamp. An
 * older marker belongs to an earlier deletion and is ignored.
 */
async function linksForRestore(
  db: Database,
  tableId: string,
  deletions: ReadonlyArray<{ recordId: string; deletedAt: string }>,
): Promise<Map<string, SavedLinks[]>> {
  if (deletions.length === 0) return new Map();
  const at = new Map(deletions.map((item) => [item.recordId, item.deletedAt]));
  const events = await db
    .selectFrom("auditEvents")
    .select(["recordId", "oldValue", "occurredAt"])
    .where("tableId", "=", tableId)
    .where("action", "=", "update")
    .where("recordId", "in", [...at.keys()])
    .orderBy("occurredAt", "desc")
    .limit(deletions.length * 8)
    .execute();
  const found = new Map<string, SavedLinks[]>();
  for (const event of events) {
    if (
      !event.recordId ||
      found.has(event.recordId) ||
      at.get(event.recordId) !== event.occurredAt.toISOString() ||
      !isLinkMarker(event.oldValue)
    ) {
      continue;
    }
    const bag = (event.oldValue as Record<string, unknown>)[M2M_RESTORE];
    if (!Array.isArray(bag)) continue;
    const links = bag.flatMap((item): SavedLinks[] => {
      const entry = item as Partial<SavedLinks> | null;
      return entry &&
        typeof entry.junction === "string" &&
        (entry.side === "left_id" || entry.side === "right_id") &&
        Array.isArray(entry.ids) &&
        entry.ids.every((id) => typeof id === "string")
        ? [{ junction: entry.junction, side: entry.side, ids: entry.ids }]
        : [];
    });
    found.set(event.recordId, links);
  }
  return found;
}

/** Brings deleted rows back from their audit snapshot, as drafts. */
export async function restoreRows(
  db: Database,
  engine: EngineCatalog,
  context: WriteContext,
  rowIds: readonly string[],
): Promise<string[]> {
  const snapshots = await deletedSnapshots(db, context, rowIds, rowIds.length);
  if (snapshots.length !== rowIds.length) {
    throw new AppError("unknown_row");
  }
  const saved = await linksForRestore(db, context.tableId, snapshots);
  // Only junctions that still exist, with the other side's current table.
  const junctions = new Map(
    (await junctionsOf(db, context.tableId)).map((item) => [
      `${item.junction}:${item.side}`,
      item,
    ]),
  );
  const physical = engine.table.columns
    .filter(
      (column) =>
        isWritableType(column.fieldType) ||
        column.fieldType === "relation_one_to_many",
    )
    .filter((column) => column.relation?.direction !== "inverse")
    .map((column) => column.name);
  await withAudit(
    db,
    { ...auditContext(context), source: "restore" },
    async (tx) => {
      for (const item of snapshots) {
        readId(
          await runRows(
            tx,
            buildRestoreRow({
              table: context.physicalName,
              columns: physical,
              snapshot: item.snapshot,
            }),
          ),
        );
        for (const links of saved.get(item.recordId) ?? []) {
          const junction = junctions.get(`${links.junction}:${links.side}`);
          if (!junction || links.ids.length === 0) continue;
          const found = await runRows(
            tx,
            buildExistingIds({ table: junction.other, ids: links.ids }),
          );
          const alive = found.map((row) => String(row.id));
          if (alive.length === 0) continue;
          const own = alive.map(() => item.recordId);
          await runRows(
            tx,
            buildInsertLinks({
              junction: junction.junction,
              leftIds: links.side === "left_id" ? own : alive,
              rightIds: links.side === "left_id" ? alive : own,
            }),
          );
        }
      }
    },
  );
  return snapshots.map((item) => item.recordId);
}

export async function setRowStatus(
  db: Database,
  input: {
    userId: string;
    role: AuditRole;
    table: { id: string; physicalName: string };
    rowId: string;
    status: "submitted" | "locked" | "draft";
    source?: string;
    depth?: number;
  },
): Promise<void> {
  const action =
    input.status === "draft"
      ? "unlock"
      : input.status === "locked"
        ? "lock"
        : "submit";
  await withAudit(
    db,
    {
      userId: input.userId,
      tableId: input.table.id,
      action,
      unlock: input.status === "draft",
      source: input.source ?? "web",
      events: { depth: input.depth ?? 0 },
    },
    async (tx) => {
      const current = await lockRow(tx, input.table.physicalName, input.rowId);
      assertStatusTransition(current, input.status, input.role);
      readId(
        await runRows(
          tx,
          buildSetStatus({
            table: input.table.physicalName,
            id: input.rowId,
            status: input.status,
          }),
        ),
      );
    },
  );
}

export async function signRow(
  db: Database,
  input: {
    userId: string;
    table: { id: string; physicalName: string };
    rowId: string;
    meaning: string;
    source?: string;
    depth?: number;
  },
): Promise<void> {
  await withAudit(
    db,
    {
      userId: input.userId,
      tableId: input.table.id,
      action: "sign",
      source: input.source ?? "web",
      events: { depth: input.depth ?? 0 },
    },
    async (tx) => {
      const current = await lockRow(tx, input.table.physicalName, input.rowId);
      if (current !== "locked") {
        throw new AppError("invalid_status");
      }
      const named = await tx
        .selectFrom("users")
        .select("displayName")
        .where("id", "=", input.userId)
        .executeTakeFirst();
      const displayName = named?.displayName;
      if (!displayName) {
        throw new AppError("no_row");
      }
      readId(
        await runRows(
          tx,
          buildSetStatus({
            table: input.table.physicalName,
            id: input.rowId,
            status: "signed",
          }),
        ),
      );
      await tx
        .insertInto("rowSignatures")
        .values({
          userId: input.userId,
          tableId: input.table.id,
          recordId: input.rowId,
          displayName,
          meaning: input.meaning,
        })
        .execute();
    },
  );
}

export async function readAudit(
  db: Database,
  tableId: string,
  recordId: string,
  hidden: (column: string) => boolean = () => false,
) {
  const rows = await db
    .selectFrom("auditEvents as e")
    .innerJoin("users as u", "u.id", "e.userId")
    .select([
      "e.occurredAt",
      "e.userId",
      "u.displayName",
      "e.action",
      "e.oldValue",
      "e.newValue",
      "e.reason",
      "e.source",
    ])
    .where("e.tableId", "=", tableId)
    .where("e.recordId", "=", recordId)
    .orderBy("e.occurredAt", "desc")
    .limit(200)
    .execute();
  const visible = (value: unknown): unknown => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return value ?? null;
    }
    return Object.fromEntries(
      Object.entries(value).filter(([name]) => !hidden(name)),
    );
  };
  return rows
    .filter((row) => !isLinkMarker(row.oldValue))
    .map((row) => ({
      occurredAt: row.occurredAt.toISOString(),
      userId: row.userId,
      displayName: row.displayName,
      action: row.action,
      oldValue: visible(row.oldValue),
      newValue: visible(row.newValue),
      reason: row.reason,
      source: row.source,
    }));
}

export async function attachSignatures(
  db: Database,
  tableId: string,
  rows: RowRecord[],
): Promise<
  Array<
    RowRecord & {
      signature: {
        displayName: string;
        meaning: string;
        signedAt: string;
      } | null;
    }
  >
> {
  const ids = rows.map((row) => row.id);
  const signed = rows
    .filter((row) => row.ag_status === "signed")
    .map((row) => row.id);
  if (ids.length === 0 || signed.length === 0) {
    return rows.map((row) => ({ ...row, signature: null }));
  }
  const signatures = await db
    .selectFrom("rowSignatures")
    .select(["recordId", "displayName", "meaning", "signedAt"])
    .where("tableId", "=", tableId)
    .where("recordId", "in", signed)
    .orderBy("signedAt", "desc")
    .execute();
  const latest = new Map<
    string,
    { displayName: string; meaning: string; signedAt: string }
  >();
  for (const signature of signatures) {
    if (!latest.has(signature.recordId)) {
      latest.set(signature.recordId, {
        displayName: signature.displayName,
        meaning: signature.meaning,
        signedAt: signature.signedAt.toISOString(),
      });
    }
  }
  return rows.map((row) => ({ ...row, signature: latest.get(row.id) ?? null }));
}

/**
 * Parses delimited text whose header names columns by name or label, and
 * coerces every cell. Returns the rows ready to insert, or throws
 * `Invalid csv` naming nothing beyond the stable message.
 */
export function parseImport(
  engine: EngineCatalog,
  text: string,
  resolveUser?: (value: string) => string | undefined,
): Array<Record<string, CellValue>> {
  const records = parseDelimited(text, {
    delimiter: detectDelimiter(text),
    maxBytes: 1_000_000,
    maxRows: 10_001,
    maxColumns: 200,
  });
  const [headers, ...body] = records;
  if (!headers) {
    throw new AppError("invalid_csv");
  }
  const columns = writeColumns(engine);
  const labels = new Map(
    engine.table.columns.map((column) => [
      column.label.toLowerCase(),
      column.name,
    ]),
  );
  const selected = headers.map((header) => {
    const trimmed = header.trim();
    const name = columns.some((column) => column.name === trimmed)
      ? trimmed
      : labels.get(trimmed.toLowerCase());
    const column = columns.find((item) => item.name === name);
    if (!column) {
      throw new AppError("invalid_csv");
    }
    return column;
  });
  return body.map((cells) => {
    const values: Record<string, CellValue> = {};
    selected.forEach((column, index) => {
      const raw = cells[index] ?? "";
      const value = coerceCellValue(column, raw, { resolveUser });
      if (value === undefined) {
        throw new AppError("invalid_cell");
      }
      values[column.name] = value;
    });
    return values;
  });
}

export function exportCsv(
  engine: EngineCatalog,
  rows: readonly RowRecord[],
  fields?: readonly string[],
): string {
  const columns = engine.table.columns.filter(
    (column) => !fields || fields.includes(column.name),
  );
  const headers = columns.map((column) => column.label);
  const mapped = rows.map((row) =>
    Object.fromEntries(
      columns.map((column) => [column.label, row[column.name]]),
    ),
  );
  return toCsv(headers, mapped);
}
