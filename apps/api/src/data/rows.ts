import {
  type AggregateItem,
  AppError,
  type AuditRole,
  type Permission,
  findAllowedTransition,
  isBlankCell,
  transitionKeyForStatus,
  buildAggregates,
  buildCountRows,
  buildDelete,
  buildExistingIds,
  buildGroupCounts,
  buildInserts,
  buildMoveRows,
  type KeptRowStamp,
  buildOrderLock,
  buildReadCells,
  buildReadRows,
  buildReadStatus,
  buildReadStatuses,
  buildLockForRowWrite,
  buildReadHeldCells,
  buildRestoreRow,
  restoredCell,
  buildSetLink,
  buildRowPlaces,
  buildSetStatus,
  buildUpdate,
  cellText,
  type CellValue,
  type EngineCatalog,
  isTimeZone,
  isWritableType,
  MAX_READ_LIMIT,
  type ParameterizedSql,
  quoteIdent,
  readsComputedText,
  type ReadSpec,
  type RowPlace,
  sameAsSeen,
  sameCell,
  placeTarget,
  type WriteColumn,
  withExactNumbers,
  type FilterGroup,
} from "@anygriddb/core";
import { type RawBuilder, sql } from "kysely";
import { reachersOf } from "./attributions.js";
import {
  readWithin,
  runStatement,
  type Database,
  type StatementStream,
} from "@anygriddb/db";
import { rowsBytes, rowsWithin, type ReadBudget } from "../read-budget.js";
import { applyControlPlaneReadSpec } from "../sources/control-plane-read-filter.js";
import { loadEnrichmentValues } from "../sources/enrichment-values.js";
import type { SummaryEvent } from "../queue/jobs.js";
import {
  runRows,
  withAudit,
  type AuditContext,
  type AuditTx,
} from "./audit-context.js";
import { loadTableCircuit } from "./status-circuits.js";
import { sourcePools } from "../sources/pools.js";
import {
  assertWritable,
  detachLinks,
  hasLinks,
  isLinkMarker,
  linkMapOf,
  linkMarker,
  linksForRestore,
  planOwnKeys,
  reattachLinks,
  recordKeyReturn,
} from "./row-links.js";
import { liveColumn } from "./live.js";
import { claimStagedAttachments } from "./staged-attachments.js";

const READ_TIMEOUT = "15s";

export type RowRecord = Record<string, unknown> & { id: string };

/**
 * The sequence number and the place rows keep from where they came from (a
 * snapshot): one each per row, in the rows' order.
 */
export type KeptOrder = {
  seqs?: readonly string[];
  positions?: readonly string[];
  /** Their dates and authors, from a copy the instance made (ADR 0117). */
  stamps?: readonly KeptRowStamp[];
};

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
   * The links of these rows are written after them: the caller asks the
   * row rule once they are, rather than of a row still without them.
   */
  deferRule?: boolean;
  /**
   * One event for the whole operation, such as an import, instead of one
   * event per row; false for none at all.
   */
  events?: false | { summary: SummaryEvent };
  /**
   * Files a public form's link sent before the answer (ADR 0062), made the
   * table's own in the transaction that writes the row.
   */
  claim?: { shareId: string; keys: readonly string[] };
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
    /** On AnyGridDB's own database, where a read can stop part way. */
    stream?: StatementStream,
  ) => Promise<T>,
): Promise<T> {
  const external = engine.table.external;
  // A synced table's copy is in AnyGridDB's database (ADR 0034).
  if (external && !external.synced) {
    return sourcePools().read(external.sourceId, body);
  }
  return readWithin(db, READ_TIMEOUT, body).catch((error: unknown) => {
    // Stopped by its time limit: said as such, with a code a client can
    // act on, and not as a fault of the server.
    throw isStatementTimeout(error)
      ? new AppError("read_timeout", { cause: error })
      : error;
  });
}

/**
 * A read of a table's rows. Oracle raises on texts joined past what its
 * text holds, and stops the whole statement for one row: the read is then
 * done again with each join tested first, which leaves that row's join
 * blank and tells why in its cell. The test writes every joined text
 * again, so no first read carries it.
 */
export async function guardingLongJoins<T>(
  engine: EngineCatalog,
  read: (engine: EngineCatalog) => Promise<T>,
): Promise<T> {
  try {
    return await read(engine);
  } catch (error) {
    if (engine.guardedJoins || !isTextTooLong(error)) throw error;
  }
  return read({ ...engine, guardedJoins: true });
}

function isTextTooLong(error: unknown): boolean {
  return error instanceof AppError && error.code === "source_text_too_long";
}

/** Rows taken from the server at a time, each lot counted before the next. */
const BUDGET_CHUNK_ROWS = 16;

/** A row at a time where a formula's text can make one row long. */
function chunkFor(page: Parameters<typeof readsComputedText>[0]): number {
  return readsComputedText(page) ? 1 : BUDGET_CHUNK_ROWS;
}

/**
 * A page under what the request may hold (ADR 0110). On AnyGridDB's own
 * database it is read a few rows at a time, and the rows past the limit
 * never reach memory. A client's database answers whole: its rows are
 * counted once read, before anything is built from them.
 */
async function pageRows(
  statement: ParameterizedSql,
  run: (statement: ParameterizedSql) => Promise<Record<string, unknown>[]>,
  stream: StatementStream | undefined,
  budget: ReadBudget | undefined,
  chunkRows: number = BUDGET_CHUNK_ROWS,
): Promise<Record<string, unknown>[]> {
  if (!budget) return run(statement);
  if (!stream) {
    const whole = await run(statement);
    budget.take(rowsBytes(whole));
    return whole;
  }
  const rows: Record<string, unknown>[] = [];
  for await (const chunk of stream(statement, chunkRows)) {
    budget.take(rowsBytes(chunk));
    for (const row of chunk) rows.push(row);
  }
  return rows;
}

type GroupRow = {
  keys: unknown[];
  depth: number;
  count: number;
  /** Where the group's rows start in the read's order, from 0. */
  start?: number;
};

type GroupsWanted = "none" | "counts" | "starts";

/**
 * The groups as a read returns them. Starts are kept only when every
 * group's rows follow each other: otherwise a grid could not place its
 * headers from them, and lays them out from the rows it reads.
 */
function groupRows(
  rows: readonly Record<string, unknown>[],
  levels: number,
  starts: boolean,
): GroupRow[] {
  const groups = rows.map((row) => ({
    keys: Array.from(
      { length: levels },
      (_, index) => row[`k${index}`] ?? null,
    ),
    depth: Number(row.depth),
    count: Number(row.count),
    start: Number(row.start),
    span: Number(row.span),
  }));
  const placed =
    starts &&
    groups.every(
      (group) =>
        Number.isSafeInteger(group.start) && group.span === group.count,
    );
  return groups.map(({ keys, depth, count, start }) =>
    placed ? { keys, depth, count, start } : { keys, depth, count },
  );
}

/** Above this many rows by its statistics, a table's total is estimated. */
const ESTIMATE_FROM = 10_000;

function parseEstimate(
  row: Record<string, unknown> | undefined,
): number | null {
  const rows = Number(row?.rows ?? Number.NaN);
  return Number.isFinite(rows) && rows >= 0 ? rows : null;
}

/**
 * A native AnyGridDB table's row count from PostgreSQL's statistics:
 * cheap once the table has been analyzed. Null when the relation is
 * missing from the catalog (should not happen for a live table).
 */
async function estimateNativeRows(
  db: Database,
  engine: EngineCatalog,
): Promise<number | null> {
  const [row] = await runStatement(db, {
    text: `select c.reltuples::bigint as "rows" from pg_class c where c.oid = to_regclass($1) and c.relkind in ('r', 'p')`,
    values: [engine.table.physicalName],
  });
  return parseEstimate(row);
}

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
  if (!external) return estimateNativeRows(db, engine);
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
  return parseEstimate(row);
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
  options: {
    total: boolean;
    exact?: boolean;
    groups?: GroupsWanted;
    budget?: ReadBudget;
  },
): Promise<{
  rows: RowRecord[];
  total: number | null;
  totalEstimated: boolean;
  groups: GroupRow[];
}> {
  if (engine.table.external) {
    return guardingLongJoins(engine, (guarded) =>
      readExternalPage(db, guarded, spec, options),
    );
  }
  const page = buildReadRows(engine, spec);
  const wanted = options.groups ?? "counts";
  const starts = wanted === "starts";
  const grouped =
    wanted === "none" ? null : buildGroupCounts(engine, spec, { starts });
  const { rows, groups } = await readTransaction(
    db,
    engine,
    async (run, stream) => ({
      rows: (await pageRows(
        page,
        run,
        stream,
        options.budget,
        chunkFor(page),
      )) as RowRecord[],
      groups: grouped
        ? groupRows(
            await pageRows(
              grouped,
              run,
              stream,
              options.budget,
              chunkFor(page),
            ),
            spec.groupBy?.length ?? 0,
            starts,
          )
        : [],
    }),
  );
  if (!options.total) {
    return { rows, total: null, totalEstimated: false, groups };
  }
  const { total, estimated } = await nativeTotal(db, engine, spec, {
    seen: (spec.offset ?? 0) + rows.length,
    exact: options.exact === true,
  });
  return { rows, total, totalEstimated: estimated, groups };
}

/**
 * How many rows of a native table a read keeps. Same rule as external
 * tables: an unfiltered large table gives the planner's estimate instead
 * of paying for COUNT(*) each time, unless `exact` asks for the count.
 */
async function nativeTotal(
  db: Database,
  engine: EngineCatalog,
  spec: ReadSpec,
  options: { seen: number; exact: boolean },
): Promise<{ total: number; estimated: boolean }> {
  const estimate = readsEveryRow(engine, spec)
    ? await estimateNativeRows(db, engine)
    : null;
  if (!options.exact && estimate !== null && estimate >= ESTIMATE_FROM) {
    return { total: estimate, estimated: true };
  }
  try {
    const [row] = await readTransaction(db, engine, (run) =>
      run(buildCountRows(engine, spec)),
    );
    return { total: Number(row?.total ?? 0), estimated: false };
  } catch (error) {
    // A count stopped by the read's time limit falls back to the
    // estimate (or at least the rows already seen) rather than failing
    // the whole read.
    if (!isReadTimeout(error)) throw error;
    return { total: Math.max(estimate ?? 0, options.seen), estimated: true };
  }
}

/**
 * How many rows of a native table its reader sees, every one of them
 * (their row rules applied): estimated past `ESTIMATE_FROM`.
 */
export function countVisibleRows(
  db: Database,
  engine: EngineCatalog,
): Promise<{ total: number; estimated: boolean }> {
  return nativeTotal(db, engine, { limit: 1 }, { seen: 0, exact: false });
}

function isReadTimeout(error: unknown): boolean {
  return error instanceof AppError && error.code === "read_timeout";
}

/** PostgreSQL's 57014: the statement ran past its `statement_timeout`. */
function isStatementTimeout(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = "code" in error ? String(error.code) : "";
  const message = "message" in error ? String(error.message) : "";
  return code === "57014" || /statement timeout/i.test(message);
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
  options: {
    total: boolean;
    exact?: boolean;
    groups?: GroupsWanted;
    budget?: ReadBudget;
  },
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
  const wanted = options.groups ?? "counts";
  const starts = wanted === "starts";
  const grouped =
    wanted === "none" ? null : buildGroupCounts(engine, clientSpec, { starts });
  const { rows, groups } = await readTransaction(
    db,
    engine,
    async (run, stream) => ({
      rows: (await pageRows(
        page,
        run,
        stream,
        options.budget,
        chunkFor(page),
      )) as RowRecord[],
      groups: grouped
        ? groupRows(
            await pageRows(
              grouped,
              run,
              stream,
              options.budget,
              chunkFor(page),
            ),
            clientSpec.groupBy?.length ?? 0,
            starts,
          )
        : [],
    }),
  );
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
  budget?: ReadBudget,
): Promise<RowRecord[]> {
  const rows = await guardingLongJoins(engine, (guarded) => {
    const statement = buildReadRows(guarded, {
      rowIds,
      limit: Math.min(Math.max(rowIds.length, 1), 1000),
      timeZone,
      ...(fields ? { fields } : {}),
    });
    return readTransaction(
      db,
      guarded,
      async (run, stream) =>
        (await pageRows(
          statement,
          run,
          stream,
          budget,
          chunkFor(statement),
        )) as RowRecord[],
    );
  });
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
        access.hidden(id, column.name) ||
        access.readOnly(id, column.name) ||
        access.shownOn?.(id, column.name) !== undefined,
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

/**
 * The engine whose table's rows are those its reader may act on (ADR
 * 0131): the attributions that give the act decide, as those that give
 * reading decide what is read.
 */
function actingOn(engine: EngineCatalog, act: Permission): EngineCatalog {
  const access = engine.access;
  if (!access) return engine;
  const own = engine.table.id;
  return {
    ...engine,
    access: {
      ...access,
      rowFilter: (tableId, asked) =>
        access.rowFilter(tableId, tableId === own ? (asked ?? act) : asked),
    },
  };
}

/** The engine whose table's rows are those `rule` keeps, its other rules as they are. */
function keptBy(engine: EngineCatalog, rule: FilterGroup): EngineCatalog {
  const access = engine.access;
  if (!access) return engine;
  const own = engine.table.id;
  return {
    ...engine,
    access: {
      ...access,
      rowFilter: (tableId, asked) =>
        tableId === own ? rule : access.rowFilter(tableId, asked),
    },
  };
}

/**
 * The rules a write of these fields asks of its rows (ADR 0144), each once:
 * a field is written only on the rows of the attributions that let it be.
 */
function fieldRules(
  engine: EngineCatalog,
  names: Iterable<string>,
): FilterGroup[] {
  const access = engine.access;
  if (!access?.writableOn) return [];
  const rules = new Map<string, FilterGroup>();
  for (const name of new Set(names)) {
    const rule = access.writableOn(engine.table.id, name);
    if (rule) rules.set(JSON.stringify(rule), rule);
  }
  return [...rules.values()];
}

/** Whether every one of these rows is among those the engine's table keeps. */
async function allKept(
  run: (statement: ParameterizedSql) => Promise<Record<string, unknown>[]>,
  engine: EngineCatalog,
  rowIds: readonly string[],
): Promise<boolean> {
  const unique = [...new Set(rowIds)];
  for (let start = 0; start < unique.length; start += MAX_READ_LIMIT) {
    const chunk = unique.slice(start, start + MAX_READ_LIMIT);
    const [row] = await run(buildCountRows(engine, { rowIds: chunk }));
    if (Number(row?.total ?? 0) !== chunk.length) return false;
  }
  return true;
}

/**
 * Refuses a write of a field on rows where no attribution that lets the
 * writer write it reaches (ADR 0144): another attribution's rows are not
 * the field's.
 */
export async function assertFieldsInScope(
  db: Database,
  engine: EngineCatalog,
  rowIds: readonly string[],
  names: Iterable<string>,
): Promise<void> {
  for (const rule of fieldRules(engine, names)) {
    const kept = keptBy(engine, rule);
    const all = await readTransaction(db, kept, (run) =>
      allKept(run, kept, rowIds),
    );
    if (!all) throw new AppError("access_denied");
  }
}

/**
 * The fields the reader sees on some rows and not on this one (ADR 0144):
 * what its history leaves out, as the row's page does.
 */
export async function fieldsHiddenOnRow(
  db: Database,
  engine: EngineCatalog,
  rowId: string,
): Promise<ReadonlySet<string>> {
  const access = engine.access;
  const hidden = new Set<string>();
  if (!access?.shownOn) return hidden;
  const id = engine.table.id;
  const byRule = new Map<string, { rule: FilterGroup; names: string[] }>();
  for (const column of engine.table.columns) {
    if (access.hidden(id, column.name)) continue;
    const rule = access.shownOn(id, column.name);
    if (!rule) continue;
    const key = JSON.stringify(rule);
    const entry = byRule.get(key) ?? { rule, names: [] };
    entry.names.push(column.name);
    byRule.set(key, entry);
  }
  for (const { rule, names } of byRule.values()) {
    const kept = keptBy(engine, rule);
    const shown = await readTransaction(db, kept, (run) =>
      allKept(run, kept, [rowId]),
    );
    if (!shown) for (const name of names) hidden.add(name);
  }
  return hidden;
}

/** Refuses an act on rows outside what the actor's rules let them act on. */
export async function assertRowsInScope(
  db: Database,
  engine: EngineCatalog,
  rowIds: readonly string[],
  act: Permission,
): Promise<void> {
  const scoped = actingOn(engine, act);
  if (!scoped.access?.rowFilter(scoped.table.id)) return;
  const unique = [...new Set(rowIds)];
  await readTransaction(db, scoped, async (run) => {
    for (let start = 0; start < unique.length; start += MAX_READ_LIMIT) {
      const chunk = unique.slice(start, start + MAX_READ_LIMIT);
      const [row] = await run(buildCountRows(scoped, { rowIds: chunk }));
      if (Number(row?.total ?? 0) !== chunk.length) {
        throw new AppError("access_denied");
      }
    }
  });
}

/** Refuses what is said of a row the table does not hold. */
export async function assertRowExists(
  db: Database,
  engine: EngineCatalog,
  rowId: string,
): Promise<void> {
  const total = await readTransaction(db, engine, async (run) => {
    const [row] = await run(buildCountRows(engine, { rowIds: [rowId] }));
    return Number(row?.total ?? 0);
  });
  if (total === 0) throw new AppError("no_row");
}

/**
 * Refuses a write that would leave a row outside its writer's row rule,
 * before it commits: the rule holds for what a row becomes, as for what it
 * was (ADR 0112). `run` is the write's own transaction.
 */
export async function assertRowsStayInRule(
  run: (statement: ParameterizedSql) => Promise<Record<string, unknown>[]>,
  engine: EngineCatalog,
  rowIds: readonly string[],
  /** The fields written: each stays on rows its writer may write it on. */
  fields: Iterable<string> = [],
): Promise<void> {
  for (const rule of fieldRules(engine, fields)) {
    if (!(await allKept(run, keptBy(engine, rule), rowIds))) {
      throw new AppError("access_denied");
    }
  }
  const scoped = actingOn(engine, "rows.write");
  if (!scoped.access?.rowFilter(scoped.table.id)) return;
  const unique = [...new Set(rowIds)];
  for (let start = 0; start < unique.length; start += MAX_READ_LIMIT) {
    const chunk = unique.slice(start, start + MAX_READ_LIMIT);
    const [row] = await run(buildCountRows(scoped, { rowIds: chunk }));
    if (Number(row?.total ?? 0) !== chunk.length) {
      throw new AppError("row_outside_rule");
    }
  }
}

/** The same in a write to AnyGridDB's own table, read as a read is, in UTC. */
export async function assertOwnRowsStayInRule(
  tx: AuditTx,
  engine: EngineCatalog,
  rowIds: readonly string[],
  fields: readonly string[] = [],
): Promise<void> {
  if (
    !actingOn(engine, "rows.write").access?.rowFilter(engine.table.id) &&
    fieldRules(engine, fields).length === 0
  ) {
    return;
  }
  await sql.raw("set local time zone 'UTC'").execute(tx);
  await assertRowsStayInRule(
    (statement) => runRows(tx, statement),
    engine,
    rowIds,
    fields,
  );
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
  const read = (asked: readonly AggregateItem[]) =>
    guardingLongJoins(engine, (guarded) => {
      const statement = buildAggregates(guarded, withoutLimit, asked);
      return readTransaction(db, guarded, async (run) => {
        const row = (await run(statement))[0] ?? {};
        return asked.map((_, index) => row[`a${index}`] ?? null);
      });
    });
  try {
    return await read(items);
  } catch (error) {
    if (!isNumberOverflow(error)) throw error;
  }
  // A figure past what the engine computes stops its whole statement: each
  // is then read alone, and that one reads empty beside the others.
  const figures: unknown[] = [];
  for (const item of items) {
    try {
      figures.push(...(await read([item])));
    } catch (error) {
      if (!isNumberOverflow(error)) throw error;
      figures.push(null);
    }
  }
  return figures;
}

function isNumberOverflow(error: unknown): boolean {
  return error instanceof AppError && error.code === "source_number_overflow";
}

/** Ids of everyone with a role on the base or one of its tables. */
export async function baseCollaboratorIds(
  db: Database,
  baseId: string,
): Promise<Set<string>> {
  return reachersOf(db, baseId);
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

/** Locks rows together and gives each one's status, by id. */
async function lockRows(
  tx: AuditTx,
  physicalName: string,
  rowIds: readonly string[],
): Promise<Map<string, string>> {
  const statuses = new Map<string, string>();
  if (rowIds.length === 0) return statuses;
  const rows = await runRows(
    tx,
    buildReadStatuses({ table: physicalName, ids: [...new Set(rowIds)] }),
  );
  for (const row of rows) {
    if (typeof row.id === "string" && typeof row.ag_status === "string") {
      statuses.set(row.id.toLowerCase(), row.ag_status);
    }
  }
  return statuses;
}

/** The row's time of last change against what the screen still shows. */
function sameMoment(current: unknown, seen: unknown): boolean {
  if (sameCell(current, seen)) return true;
  const left = epoch(current);
  const right = epoch(seen);
  return left !== null && right !== null && left === right;
}

function epoch(value: unknown): number | null {
  if (value instanceof Date) return value.getTime();
  if (typeof value !== "string") return null;
  if (!/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value)) return null;
  const parsed = Date.parse(
    value.length === 10 ? `${value}T00:00:00.000Z` : value,
  );
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Refuses to put a row back when it no longer holds what the screen shows
 * (ADR 0089). A field is read as a page reads it and compared by its type;
 * the row's time of last change is read from its column.
 */
async function assertStoredNow(
  tx: AuditTx,
  engine: EngineCatalog,
  physicalName: string,
  updates: ReadonlyArray<{
    rowId: string;
    storedNow?: Readonly<Record<string, unknown>> | undefined;
  }>,
): Promise<void> {
  for (const update of updates) {
    if (!update.storedNow) continue;
    const names = Object.keys(update.storedNow);
    if (names.length === 0) continue;
    const fields = names.filter((name) => name !== "ag_updated_at");
    if (fields.length < names.length) {
      const [row] = await runRows(
        tx,
        buildReadCells({
          table: physicalName,
          id: update.rowId,
          columns: ["ag_updated_at"],
        }),
      );
      if (!row) throw new AppError("no_row");
      if (!sameMoment(row.ag_updated_at, update.storedNow.ag_updated_at)) {
        throw new AppError("revert_stale");
      }
    }
    if (fields.length === 0) continue;
    const [row] = (await runRows(
      tx,
      buildReadRows(engine, {
        rowIds: [update.rowId],
        limit: 1,
        timeZone: "UTC",
        fields,
      }),
    )) as RowRecord[];
    if (!row) throw new AppError("no_row");
    for (const name of fields) {
      const column = engine.table.columns.find((item) => item.name === name);
      if (!column) throw new AppError("unknown_column", name);
      if (!sameAsSeen(column.fieldType, row[name], update.storedNow[name])) {
        throw new AppError("revert_stale");
      }
    }
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

/**
 * Places for `count` rows beside the row `place` names, the table's order
 * held until the transaction ends (`row-order.ts`).
 */
async function placesBeside(
  tx: AuditTx,
  physicalName: string,
  place: RowPlace,
  count: number,
): Promise<string[]> {
  await runRows(tx, buildOrderLock(physicalName));
  const [found] = await runRows(
    tx,
    buildRowPlaces({ table: physicalName, place, count }),
  );
  const positions = found?.positions;
  if (
    !Array.isArray(positions) ||
    positions.length !== count ||
    positions.some((value) => typeof value !== "string")
  ) {
    throw new AppError("no_row");
  }
  return positions as string[];
}

/**
 * A write was checked and built against the fields its engine read, which
 * a conversion may have changed since. With the table's lock held, none
 * can change until it commits: a field no longer of that type refuses it.
 */
async function holdFieldTypes(
  tx: AuditTx,
  engine: EngineCatalog,
  context: { tableId: string; physicalName: string },
  written: readonly string[],
): Promise<void> {
  const names = [...new Set(written)];
  if (names.length === 0) return;
  await runRows(tx, buildLockForRowWrite(context.physicalName));
  const now = await tx
    .selectFrom("dataColumns")
    .select(["name", "fieldType"])
    .where("tableId", "=", context.tableId)
    .where("name", "in", names)
    .where(liveColumn())
    .execute();
  const types = new Map(engine.table.columns.map((c) => [c.name, c.fieldType]));
  for (const column of now) {
    if (types.get(column.name) !== column.fieldType) {
      throw new AppError("field_changed", column.name);
    }
  }
}

export async function insertRows(
  db: Database,
  engine: EngineCatalog,
  context: WriteContext,
  rows: ReadonlyArray<Readonly<Record<string, CellValue>>>,
  place?: RowPlace,
  kept?: KeptOrder,
): Promise<string[]> {
  const columns = writeColumns(engine);
  await assertUserValues(db, context.baseId, columns, rows);
  const audit = {
    ...auditContext(context),
    ...(kept?.stamps ? { keepRowState: true } : {}),
  };
  return withAudit(db, audit, async (tx) => {
    await holdFieldTypes(
      tx,
      engine,
      context,
      rows.flatMap((row) => Object.keys(row)),
    );
    if (context.claim) {
      await claimStagedAttachments(
        tx,
        context.claim.shareId,
        context.claim.keys,
      );
    }
    const positions =
      kept?.positions ??
      (place
        ? await placesBeside(tx, context.physicalName, place, rows.length)
        : undefined);
    // Rows that set the same fields go in one statement, not one each.
    const statements = buildInserts({
      table: context.physicalName,
      columns,
      rows,
      positions,
      seqs: kept?.seqs,
      stamps: kept?.stamps,
    });
    const ids: string[] = [];
    for (const { statement, rows: expected } of statements) {
      const inserted = await runRows(tx, statement);
      if (inserted.length !== expected) {
        throw new AppError("no_row");
      }
      for (const row of inserted) {
        ids.push(readId([row]));
      }
    }
    if (!context.deferRule) {
      await assertOwnRowsStayInRule(
        tx,
        engine,
        ids,
        rows.flatMap((row) => Object.keys(row)),
      );
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
    /**
     * What the writer saw in the fields they change, as a read gave them:
     * the locked row must still read the same, or nothing is written
     * (ADR 0103).
     */
    expected?: Readonly<Record<string, CellValue>> | undefined;
    /**
     * What the row must still hold, set by the server when a value is put
     * back: the locked row must match, or nothing is written (ADR 0089).
     */
    storedNow?: Readonly<Record<string, unknown>>;
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
    await holdFieldTypes(
      tx,
      engine,
      context,
      updates.flatMap((update) => Object.keys(update.values)),
    );
    // Every row is locked first, in one statement, then checked in the
    // order asked: the first one missing or locked refuses the write.
    const statuses = await lockRows(
      tx,
      context.physicalName,
      statements.map((item) => item.rowId),
    );
    for (const item of statements) {
      const status = statuses.get(item.rowId.toLowerCase());
      if (status === undefined) {
        throw new AppError("no_row");
      }
      assertWritable(status);
    }
    await assertStoredNow(tx, engine, context.physicalName, updates);
    await assertAsSeen(tx, engine, updates);
    for (const item of statements) {
      readId(await runRows(tx, item.statement));
    }
    await assertOwnRowsStayInRule(
      tx,
      engine,
      statements.map((item) => item.rowId),
      updates.flatMap((update) => Object.keys(update.values)),
    );
  });
  return statements.map((item) => item.rowId);
}

/**
 * Refuses a write whose author saw something else in a field they change.
 * The rows are locked: they are read again through the read engine, as the
 * author's page read them, and compared field by field. Two writers of
 * different fields of one row do not meet. Only the fields written are
 * compared, which the author may read: what they claim to have seen in
 * another field is not looked at, so a guess learns nothing.
 */
async function assertAsSeen(
  tx: AuditTx,
  engine: EngineCatalog,
  updates: ReadonlyArray<{
    rowId: string;
    values: Readonly<Record<string, CellValue>>;
    expected?: Readonly<Record<string, CellValue>> | undefined;
  }>,
): Promise<void> {
  const compared = updates.flatMap((update) => {
    const seen = update.expected;
    if (!seen) return [];
    const names = Object.keys(update.values).filter((name) =>
      Object.hasOwn(seen, name),
    );
    return names.length > 0 ? [{ rowId: update.rowId, seen, names }] : [];
  });
  if (compared.length === 0) return;
  const fields = [...new Set(compared.flatMap((item) => item.names))];
  const rowIds = [...new Set(compared.map((item) => item.rowId))];
  const current = new Map<string, RowRecord>();
  for (let index = 0; index < rowIds.length; index += MAX_READ_LIMIT) {
    const chunk = rowIds.slice(index, index + MAX_READ_LIMIT);
    const rows = (await runRows(
      tx,
      buildReadRows(engine, {
        rowIds: chunk,
        limit: chunk.length,
        timeZone: "UTC",
        fields,
      }),
    )) as RowRecord[];
    for (const row of rows) current.set(row.id.toLowerCase(), row);
  }
  for (const item of compared) {
    const row = current.get(item.rowId.toLowerCase());
    if (!row) throw new AppError("no_row");
    for (const name of item.names) {
      const column = engine.table.columns.find((entry) => entry.name === name);
      if (!column) throw new AppError("unknown_column", name);
      if (sameAsSeen(column.fieldType, row[name], item.seen[name])) continue;
      throw new AppError("row_conflict", column.label);
    }
  }
}

/**
 * Puts rows just before or just after another, keeping the order they had
 * among themselves. Only their place changes: the trail records the move,
 * their last change stays as it was, and a locked or signed row stays
 * where it is.
 */
export async function moveRows(
  db: Database,
  context: WriteContext,
  rowIds: readonly string[],
  place: RowPlace,
): Promise<string[]> {
  const target = placeTarget(place).rowId.toLowerCase();
  if (rowIds.some((id) => id.toLowerCase() === target)) {
    throw new AppError("invalid_place");
  }
  return withAudit(db, auditContext(context), async (tx) => {
    const positions = await placesBeside(
      tx,
      context.physicalName,
      place,
      rowIds.length,
    );
    const statuses = await lockRows(tx, context.physicalName, rowIds);
    for (const rowId of rowIds) {
      const status = statuses.get(rowId.toLowerCase());
      if (status === undefined) {
        throw new AppError("no_row");
      }
      assertWritable(status);
    }
    const moved = await runRows(
      tx,
      buildMoveRows({ table: context.physicalName, rowIds, positions }),
    );
    return moved.map((row) => readId([row]));
  });
}

/**
 * Deletes rows. What they were linked to is changed here, under each linked
 * row's own table and refused when one is locked or signed (`row-links.ts`),
 * and kept in the same transaction for a restore.
 */
export async function deleteRows(
  db: Database,
  context: WriteContext,
  rowIds: readonly string[],
): Promise<{ ids: string[]; touchedTables: string[] }> {
  const map = await linkMapOf(db, context.tableId);
  const touchedTables = await withAudit(
    db,
    auditContext(context),
    async (tx) => {
      const touched = new Set<string>();
      for (const rowId of rowIds) {
        assertWritable(await lockRow(tx, context.physicalName, rowId));
        const detached = await detachLinks(tx, context, map, rowId);
        for (const id of detached.touched) touched.add(id);
        readId(
          await runRows(
            tx,
            buildDelete({ table: context.physicalName, id: rowId }),
          ),
        );
        // In the same transaction, so the event shares the delete's timestamp.
        if (hasLinks(detached.kept)) {
          await tx
            .insertInto("auditEvents")
            .values({
              userId: context.userId,
              action: "update",
              tableId: context.tableId,
              recordId: rowId,
              ...linkMarker(detached.kept),
              reason: context.reason,
              source: context.source,
            })
            .execute();
        }
      }
      return [...touched];
    },
  );
  return { ids: [...rowIds], touchedTables };
}

type LastDelete = {
  id: string;
  recordId: string | null;
  oldValue: unknown;
  occurredAt: Date;
  userId: string;
  displayName: string;
};

/**
 * The last `delete` of each row of a table, newest first: one event a
 * row, however often the row was deleted and put back.
 */
function lastDeletes(
  db: Database,
  tableId: string,
  input: {
    rowIds: readonly string[] | null;
    deletedBy: string | undefined;
    limit: number;
    offset: number;
  },
): Promise<LastDelete[]> {
  let each = db
    .selectFrom("auditEvents as e")
    .distinctOn("e.recordId")
    .select(["e.id", "e.recordId", "e.oldValue", "e.occurredAt", "e.userId"])
    .where("e.tableId", "=", tableId)
    .where("e.action", "=", "delete")
    .where("e.recordId", "is not", null);
  if (input.rowIds) each = each.where("e.recordId", "in", [...input.rowIds]);
  let last = db
    .selectFrom(
      each
        .orderBy("e.recordId")
        .orderBy("e.writeOrder", (order) => order.desc().nullsLast())
        .orderBy("e.occurredAt", "desc")
        .orderBy("e.id", "desc")
        .as("d"),
    )
    .innerJoin("users as u", "u.id", "d.userId")
    .select([
      "d.id",
      "d.recordId",
      "d.oldValue",
      "d.occurredAt",
      "d.userId",
      "u.displayName",
    ]);
  // Only the rows whose last delete is this account's.
  if (input.deletedBy) last = last.where("d.userId", "=", input.deletedBy);
  return last
    .orderBy("d.occurredAt", "desc")
    .orderBy("d.id", "desc")
    .limit(input.limit)
    .offset(input.offset)
    .execute();
}

/**
 * Latest `delete` snapshot of each row, for rows that do not exist now,
 * newest first. It reads rows, not a window of events: a row deleted and
 * put back many times filled such a window alone, and hid every other row
 * of the trash, or made a restore of several rows miss one of them.
 */
async function deletedSnapshots(
  db: Database,
  context: { tableId: string; physicalName: string },
  rowIds: readonly string[] | null,
  limit: number,
  /** Only the rows this account deleted last. */
  deletedBy?: string,
): Promise<
  Array<{
    recordId: string;
    /** The `delete` event of the trail that holds the row. */
    eventId: string;
    snapshot: Record<string, unknown>;
    deletedAt: string;
    deletedBy: string;
  }>
> {
  if (rowIds?.length === 0) return [];
  const result: Array<{
    recordId: string;
    eventId: string;
    snapshot: Record<string, unknown>;
    deletedAt: string;
    deletedBy: string;
  }> = [];
  // Rows put back since are passed over: read on until the page is full.
  const page = rowIds ? rowIds.length : Math.max(limit * 2, 50);
  for (let offset = 0; result.length < limit; offset += page) {
    const events = await lastDeletes(db, context.tableId, {
      rowIds,
      deletedBy,
      limit: page,
      offset,
    });
    const ids = events.flatMap((event) => event.recordId ?? []);
    if (ids.length === 0) break;
    const present = await runStatement(
      db,
      buildExistingIds({ table: context.physicalName, ids }),
    );
    const alive = new Set(present.map((row) => String(row.id)));
    for (const event of events) {
      if (
        !event.recordId ||
        alive.has(event.recordId) ||
        !event.oldValue ||
        typeof event.oldValue !== "object"
      ) {
        continue;
      }
      result.push({
        recordId: event.recordId,
        eventId: event.id,
        snapshot: event.oldValue as Record<string, unknown>,
        deletedAt: event.occurredAt.toISOString(),
        deletedBy: event.displayName,
      });
      if (result.length >= limit) break;
    }
    if (events.length < page) break;
  }
  return result;
}

export async function listTrash(
  db: Database,
  engine: EngineCatalog,
  context: { tableId: string; physicalName: string },
  limit: number,
  /**
   * A collaborator with field or row rules: only the rows they deleted,
   * named by their primary field when they may see it.
   */
  deletedBy?: string,
) {
  const primary = engine.table.primaryColumn;
  const named =
    primary && !engine.access?.hidden(engine.table.id, primary)
      ? primary
      : undefined;
  const deleted = await deletedSnapshots(db, context, null, limit, deletedBy);
  return deleted.map((item) => ({
    rowId: item.recordId,
    label:
      cellText(named ? item.snapshot[named] : item.recordId) || item.recordId,
    deletedAt: item.deletedAt,
    deletedBy: item.deletedBy,
  }));
}

/**
 * Brings deleted rows back from their audit snapshot, as drafts, then their
 * links. `linksNotRestored` counts those left out because the row on the
 * other side was locked or signed meanwhile.
 */
export async function restoreRows(
  db: Database,
  engine: EngineCatalog,
  context: WriteContext,
  rowIds: readonly string[],
  /** Only rows this account deleted last: a collaborator with rules. */
  deletedBy?: string,
): Promise<{
  ids: string[];
  linksNotRestored: number;
  /** Values that no longer fit their field, since converted: left empty. */
  valuesCleared: number;
  touchedTables: string[];
}> {
  const snapshots = await deletedSnapshots(
    db,
    context,
    rowIds,
    rowIds.length,
    deletedBy,
  );
  if (snapshots.length !== rowIds.length) {
    throw new AppError("unknown_row");
  }
  const saved = await linksForRestore(db, context.tableId, snapshots);
  const map = await linkMapOf(db, context.tableId);
  const physical = engine.table.columns
    .filter(
      (column) =>
        isWritableType(column.fieldType) ||
        column.fieldType === "relation_one_to_many",
    )
    .filter((column) => column.relation?.direction !== "inverse")
    .map(({ name, fieldType, config }) => ({ name, fieldType, config }));
  const restoring = { ...context, source: "restore" };
  const outcome = await withAudit(
    db,
    { ...auditContext(context), source: "restore" },
    async (tx) => {
      const keys = await planOwnKeys(
        tx,
        restoring,
        map,
        snapshots,
        saved,
        new Set(physical.map((column) => column.name)),
      );
      let refused = keys.refused;
      let cleared = 0;
      const touched = new Set<string>();
      await holdFieldTypes(
        tx,
        engine,
        context,
        physical.map((column) => column.name),
      );
      const heldRows = await runRows(
        tx,
        buildReadHeldCells({
          events: snapshots.map((item) => item.eventId),
          columns: physical.map((column) => column.name),
        }),
      );
      const heldBy = new Map(
        heldRows.map((row) => [
          String(row.event),
          (row.held ?? {}) as Record<
            string,
            string | boolean | string[] | null
          >,
        ]),
      );
      for (const item of snapshots) {
        const left = keys.left.get(item.recordId);
        const columns = left
          ? physical.filter((column) => !left.has(column.name))
          : physical;
        const held = heldBy.get(item.eventId) ?? {};
        const values: Record<string, unknown> = {};
        for (const column of columns) {
          const value = held[column.name] ?? null;
          if (value === null) continue;
          const back = restoredCell(column, value);
          if (back === undefined) cleared += 1;
          values[column.name] = back ?? null;
        }
        readId(
          await runRows(
            tx,
            buildRestoreRow({
              table: context.physicalName,
              columns,
              values,
              id: item.recordId,
              event: item.eventId,
            }),
          ),
        );
      }
      // Every row is back: a key between two of them can be written.
      for (const { rowId, column, targetId } of keys.later) {
        readId(
          await runRows(
            tx,
            buildSetLink({
              table: context.physicalName,
              column,
              rowId,
              targetId,
            }),
          ),
        );
      }
      // A key that came back shows again on the row it points to.
      for (const { rowId, key, targetId } of keys.back) {
        if (key.inverseField === null) continue;
        await recordKeyReturn(tx, restoring, key, rowId, targetId);
        touched.add(key.tableId);
      }
      for (const item of snapshots) {
        const links = saved.get(item.recordId);
        if (!links) continue;
        const back = await reattachLinks(
          tx,
          restoring,
          map,
          item.recordId,
          links,
        );
        refused += back.refused;
        for (const id of back.touched) touched.add(id);
      }
      return { refused, cleared, touched: [...touched] };
    },
  );
  return {
    ids: snapshots.map((item) => item.recordId),
    linksNotRestored: outcome.refused,
    valuesCleared: outcome.cleared,
    touchedTables: outcome.touched,
  };
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
  await transitionRow(db, {
    userId: input.userId,
    role: input.role,
    table: input.table,
    rowId: input.rowId,
    transitionKey: transitionKeyForStatus(input.status),
    source: input.source,
    depth: input.depth,
  });
}

export async function transitionRow(
  db: Database,
  input: {
    userId: string;
    role: AuditRole;
    table: { id: string; physicalName: string };
    rowId: string;
    transitionKey: string;
    reason?: string;
    meaning?: string;
    source?: string;
    depth?: number;
  },
): Promise<{ from: string; to: string; transitionKey: string }> {
  const circuit = await loadTableCircuit(db, input.table.id);
  let outcome = { from: "", to: "", transitionKey: input.transitionKey };

  await withAudit(
    db,
    {
      userId: input.userId,
      tableId: input.table.id,
      action: input.transitionKey,
      unlock: input.transitionKey === "unlock",
      reason: input.reason ?? null,
      source: input.source ?? "web",
      events: { depth: input.depth ?? 0 },
    },
    async (tx) => {
      const current = await lockRow(tx, input.table.physicalName, input.rowId);
      const transition = findAllowedTransition(
        circuit,
        current,
        input.transitionKey,
        input.role,
      );
      if (transition.requireReason) {
        if (!input.reason || input.reason.trim() === "") {
          throw new AppError("reason_required");
        }
      }
      if (transition.requireFields.length > 0) {
        // What the row holds now, under its lock: the step's fields are
        // filled there, or the step waits for them.
        const { rows: held } = await sql<{ row: Record<string, unknown> }>`
          select to_jsonb(t) as row from ${sql.table(input.table.physicalName)} t
           where t.id = ${input.rowId}
        `.execute(tx);
        const values = held[0]?.row ?? {};
        const blank = transition.requireFields.filter((field) =>
          isBlankCell(values[field]),
        );
        if (blank.length > 0) {
          const named = await tx
            .selectFrom("dataColumns")
            .select(["name", "label"])
            .where("tableId", "=", input.table.id)
            .where("name", "in", blank)
            .execute();
          const label = (field: string) =>
            named.find((column) => column.name === field)?.label ?? field;
          throw new AppError("value_required", label(blank[0] ?? ""));
        }
      }
      if (transition.fourEyes) {
        const previous = await tx
          .selectFrom("auditEvents")
          .select("userId")
          .where("tableId", "=", input.table.id)
          .where("recordId", "=", input.rowId)
          .where("action", "in", [
            "submit",
            "lock",
            "unlock",
            "sign",
            "transition",
          ])
          .orderBy("id", "desc")
          .executeTakeFirst();
        if (previous && previous.userId === input.userId) {
          throw new AppError("four_eyes");
        }
      }
      if (transition.signature !== "none") {
        if (!input.meaning || input.meaning.trim() === "") {
          throw new AppError("meaning_required");
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
        await tx
          .insertInto("rowSignatures")
          .values({
            userId: input.userId,
            tableId: input.table.id,
            recordId: input.rowId,
            displayName,
            meaning: input.meaning.trim(),
          })
          .execute();
      }
      readId(
        await runRows(
          tx,
          buildSetStatus({
            table: input.table.physicalName,
            id: input.rowId,
            status: transition.toStateKey,
          }),
        ),
      );
      outcome = {
        from: current,
        to: transition.toStateKey,
        transitionKey: transition.key,
      };
    },
  );
  return outcome;
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
    role?: AuditRole;
  },
): Promise<void> {
  await transitionRow(db, {
    userId: input.userId,
    role: input.role ?? "owner",
    table: input.table,
    rowId: input.rowId,
    transitionKey: "sign",
    meaning: input.meaning,
    source: input.source,
    depth: input.depth,
  });
}

/** The numbers of a trail payload, each as the text the database writes. */
export function trailNumbers(payload: RawBuilder<unknown>) {
  return sql<Record<
    string,
    string
  > | null>`(case when jsonb_typeof(${payload}) = 'object' then (select jsonb_object_agg(n.key, n.value #>> '{}') from jsonb_each(${payload}) n where jsonb_typeof(n.value) = 'number') end)`;
}

export async function readAudit(
  db: Database,
  tableId: string,
  recordId: string,
  hidden: (column: string) => boolean = () => false,
  budget?: ReadBudget,
) {
  const events = db
    .selectFrom("auditEvents as e")
    .innerJoin("users as u", "u.id", "e.userId")
    .leftJoin("users as p", "p.id", "e.impersonatedUserId")
    .select([
      "e.id",
      "e.occurredAt",
      "e.userId",
      "u.displayName",
      "p.displayName as actingName",
      "e.action",
      "e.oldValue",
      "e.newValue",
      "e.reason",
      "e.source",
    ])
    .select([
      trailNumbers(sql.ref("e.old_value")).as("oldNumbers"),
      trailNumbers(sql.ref("e.new_value")).as("newNumbers"),
    ])
    .where("e.tableId", "=", tableId)
    .where("e.recordId", "=", recordId)
    .orderBy("e.writeOrder", (order) => order.desc().nullsLast())
    .orderBy("e.occurredAt", "desc")
    .orderBy("e.id", "desc")
    .limit(200);
  const rows = await rowsWithin(events, budget);
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
      id: row.id,
      occurredAt: row.occurredAt.toISOString(),
      userId: row.userId,
      displayName: row.displayName,
      actingName: row.actingName,
      action: row.action,
      oldValue: visible(withExactNumbers(row.oldValue, row.oldNumbers)),
      newValue: visible(withExactNumbers(row.newValue, row.newNumbers)),
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
      ag_signature: {
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
    return rows.map((row) => ({ ...row, ag_signature: null }));
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
  return rows.map((row) => ({
    ...row,
    ag_signature: latest.get(row.id) ?? null,
  }));
}
