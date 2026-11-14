/**
 * Synced mode (ADRs 0006, 0034): a client's table read from a copy in
 * AnyGridDB's database, refreshed on a schedule.
 *
 * It suits a DBA who refuses live queries on a production database: the
 * client's table is read once per interval, a page at a time in short
 * read-only transactions, and every read people make goes to the copy.
 * A refresh loads a new copy beside the current one, compares the two,
 * and swaps them in one transaction. What changed reaches open grids,
 * webhooks, and automations like a change made elsewhere (ADR 0031),
 * deletes included. The copy is read-only.
 */
import {
  AppError,
  buildCopyCreate,
  buildCopyDiff,
  buildCopyDrop,
  buildCopyInsert,
  buildCopyUpsert,
  buildCopySwap,
  buildReadRows,
  buildWatchPage,
  buildWatchStart,
  copyColumns,
  copyRow,
  type CopyColumn,
  type EngineCatalog,
  type EngineTable,
  keyValues,
  MAX_READ_LIMIT,
  type RowEvent,
  sealedFields,
  SYNC_SCHEMA,
  watchKind,
  type WatchColumn,
} from "@anygriddb/core";
import { runStatement, type Database } from "@anygriddb/db";
import { sql } from "kysely";
import { withAudit } from "../data/audit-context.js";
import { announceRows } from "../data/announce.js";
import { loadEngine, sourceDialect } from "../data/engine.js";
import { readTransaction } from "../data/rows.js";
import { addJob, TASKS, type SqlExecutor } from "../queue/jobs.js";
import type { Bus } from "../realtime/bus.js";
import { publishCatalog, publishRows } from "../realtime/channels.js";
import { sourcePools } from "./pools.js";
import { keyOf } from "./watch.js";
import { checkSeals, type SealDeps } from "./statuses.js";

/** Rows read from the client's table at a time. */
const PAGE = Math.min(1_000, MAX_READ_LIMIT);
/** A copy stops here: past it, the table is better read live. */
const SYNC_ROW_LIMIT = 1_000_000;
/** Changes one refresh tells row by row; past it, one event per kind. */
const EVENT_LIMIT = 200;
/** A refresh that failed is tried again this soon, at most. */
const RETRY_SECONDS = 300;
/** A copy no longer read is dropped this long after: reads under way end. */
const DROP_AFTER_MS = 60_000;

type SyncInput = {
  tableId: string;
  /** Null reads the table live again, and drops its copy. */
  intervalMinutes: number | null;
  /** Full copy each time, or changed rows plus a periodic full reconcile. */
  syncMode?: "full" | "incremental";
  /** Client column that moves on every change; required for incremental. */
  changeColumn?: string | null;
  /** Full reconcile every N incremental refreshes (default 24). */
  fullEvery?: number;
};

function syncJobKey(tableId: string): string {
  return `external_sync:${tableId}`;
}

/**
 * Whether this refresh must rebuild the whole copy: always for full mode,
 * and for incremental when the change column / watermark is missing or the
 * periodic full reconcile is due.
 */
export function incrementalDueFull(sync: {
  syncMode: string;
  changeColumn: string | null;
  columns: unknown;
  watermark: string | null;
  refreshCount: number;
  fullEvery: number;
}): boolean {
  return (
    sync.syncMode !== "incremental" ||
    !sync.changeColumn ||
    !sync.columns ||
    sync.watermark === null ||
    (sync.refreshCount > 0 &&
      sync.refreshCount % Math.max(1, sync.fullEvery) === 0)
  );
}

/** Queues the table's next refresh, replacing a queued one. */
export async function queueSync(
  executor: SqlExecutor,
  tableId: string,
  delaySeconds: number,
  mode: "replace" | "preserve_run_at" = "replace",
): Promise<void> {
  await addJob(
    executor,
    TASKS.externalSync,
    { tableId },
    {
      runAt: new Date(Date.now() + delaySeconds * 1000),
      jobKey: syncJobKey(tableId),
      jobKeyMode: mode,
      maxAttempts: 1,
    },
  );
}

/**
 * Sets a client's table in synced mode, or back to live. The first copy is
 * made at once; until it is there, the table is read live. A table read
 * from a copy needs no watch for changes made elsewhere: each refresh
 * tells them.
 */
export async function setTableSync(
  db: Database,
  actorId: string,
  input: SyncInput,
): Promise<{ baseId: string }> {
  const table = await db
    .selectFrom("dataTables")
    .select(["id", "baseId", "storage", "sourceId"])
    .where("id", "=", input.tableId)
    .where("deletedAt", "is", null)
    .executeTakeFirst();
  if (table?.storage !== "external" || !table.sourceId) {
    throw new AppError("unknown_table");
  }
  const sourceId = table.sourceId;
  await withAudit(
    db,
    { userId: actorId, tableId: table.id, source: "web" },
    async (tx) => {
      if (input.intervalMinutes === null) {
        await tx
          .deleteFrom("externalSyncs")
          .where("tableId", "=", table.id)
          .execute();
        // Reads that began on the copy finish on it: it goes a minute later.
        await addJob(
          tx,
          TASKS.externalSyncDrop,
          { tableId: table.id },
          {
            runAt: new Date(Date.now() + DROP_AFTER_MS),
            jobKey: `external_sync_drop:${table.id}`,
            jobKeyMode: "replace",
            maxAttempts: 3,
          },
        );
        return;
      }
      const syncMode = input.syncMode ?? "full";
      const changeColumn =
        syncMode === "incremental" ? (input.changeColumn ?? null) : null;
      if (syncMode === "incremental") {
        await assertChangeColumn(tx, table.id, sourceId, changeColumn);
      }
      await tx
        .insertInto("externalSyncs")
        .values({
          tableId: table.id,
          intervalMinutes: input.intervalMinutes,
          syncMode,
          changeColumn,
          fullEvery: input.fullEvery ?? 24,
          updatedBy: actorId,
        })
        .onConflict((conflict) =>
          conflict.column("tableId").doUpdateSet({
            intervalMinutes: input.intervalMinutes ?? 15,
            syncMode,
            changeColumn,
            fullEvery: input.fullEvery ?? 24,
            // New settings start from a full copy, which takes the mark.
            watermark: null,
            refreshCount: 0,
            updatedBy: actorId,
            updatedAt: new Date(),
          }),
        )
        .execute();
      await tx
        .deleteFrom("externalWatches")
        .where("tableId", "=", table.id)
        .execute();
      await queueSync(tx, table.id, 0);
    },
  );
  return { baseId: table.baseId };
}

/**
 * An incremental refresh needs a client column the database moves on every
 * change, as a watch does (ADR 0031): a date and time, or a rowversion.
 */
async function assertChangeColumn(
  db: Pick<Database, "selectFrom">,
  tableId: string,
  sourceId: string,
  name: string | null,
): Promise<void> {
  if (!name) throw new AppError("source_watch_column");
  const found = await db
    .selectFrom("dataColumns as c")
    .innerJoin("sources as s", (join) => join.on("s.id", "=", sourceId))
    .select(["c.externalType", "s.engine"])
    .where("c.tableId", "=", tableId)
    .where("c.physicalName", "=", name)
    .where("c.externalSide", "=", false)
    .where("c.deletedAt", "is", null)
    .executeTakeFirst();
  if (
    !found?.externalType ||
    watchKind(sourceDialect(found.engine), found.externalType) === null
  ) {
    throw new AppError("source_watch_column");
  }
}

/** Refreshes a synced table now, whatever its interval. */
export async function syncNow(db: Database, tableId: string): Promise<void> {
  const found = await db
    .selectFrom("externalSyncs")
    .select("tableId")
    .where("tableId", "=", tableId)
    .executeTakeFirst();
  if (!found) throw new AppError("unknown_table");
  await queueSync(db, tableId, 0);
}

type SyncDeps = {
  db: Database;
  bus: Bus;
  log: (error: unknown, message: string) => void;
  /** Compares at once the sealed rows a refresh found changed (ADR 0033). */
  seals?: SealDeps;
};

type Change = { op: "insert" | "update" | "delete"; id: string };

type Diff = { changes: Change[]; counts: Map<Change["op"], number> };

/** Row events of one refresh: one per row, or one per kind past the limit. */
function eventsOf(tableId: string, diff: Diff): RowEvent[] {
  const at = new Date().toISOString();
  const total = [...diff.counts.values()].reduce(
    (sum, value) => sum + value,
    0,
  );
  if (total <= EVENT_LIMIT) {
    return diff.changes.map((change) => ({
      tableId,
      event: change.op,
      rowId: change.id,
      source: "external",
      at,
    }));
  }
  return [...diff.counts].map(([op, count]) => ({
    tableId,
    event: op,
    count,
    source: "external",
    at,
  }));
}

function totalOf(diff: Diff | null): number {
  return diff
    ? [...diff.counts.values()].reduce((sum, value) => sum + value, 0)
    : 0;
}

/** Drops the next copy a refresh left behind. */
async function dropNext(db: Database, tableId: string): Promise<void> {
  const [next] = buildCopyDrop(tableId);
  if (next) await runStatement(db, next).catch(() => undefined);
}

/**
 * Copies the client's table into the next copy, a page at a time. Each
 * page is its own short read: a row a write moves between two pages is
 * read twice or not at all, and the next refresh sets it right.
 */

/** Where an incremental refresh stands: the change column's mark. */
type SyncMark = { value: string | null; key: readonly string[] | null };

function parseMark(text: string | null): SyncMark | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && "value" in parsed) {
      const { value, key } = parsed as { value: unknown; key?: unknown };
      return {
        value: typeof value === "string" ? value : null,
        key: Array.isArray(key) ? key.map(String) : null,
      };
    }
  } catch {
    // An older or damaged mark: the next refresh copies the table whole.
  }
  return null;
}

/** A synced table read live, its links as the keys they hold. */
async function liveTable(deps: SyncDeps, tableId: string) {
  const { engine, rows: catalog } = await loadEngine(
    deps.db,
    tableId,
    () => true,
    { live: true },
  );
  const declared = new Map<string, string>();
  for (const column of catalog.columns) {
    if (column.tableId === tableId && column.externalType) {
      declared.set(column.physicalName, column.externalType);
    }
  }
  // A link is copied as the key it holds: its foreign key is read as a
  // plain column, without joining the other table for labels.
  const plain: EngineCatalog = {
    ...engine,
    table: {
      ...engine.table,
      columns: engine.table.columns.map((column) =>
        column.relation?.direction === "forward" && column.physical
          ? {
              id: column.id,
              name: column.name,
              label: column.label,
              fieldType: "text" as const,
              config: {},
              physical: column.physical,
            }
          : column,
      ),
    },
  };
  return { engine, plain, declared };
}

/** The client column that tells changes, as the watch builders read it. */
function changeColumnOf(
  table: EngineTable,
  declared: ReadonlyMap<string, string>,
  name: string,
): WatchColumn {
  const type = declared.get(name);
  const dialect = table.external?.dialect;
  if (!type || !dialect || watchKind(dialect, type) === null) {
    throw new AppError("source_watch_column");
  }
  return { name, type };
}

/** The change column's mark now, before a full copy reads the table. */
async function startMark(
  deps: SyncDeps,
  tableId: string,
  changeColumn: string,
): Promise<string | null> {
  const { engine, declared } = await liveTable(deps, tableId);
  const sourceId = engine.table.external?.sourceId;
  if (!sourceId) return null;
  const column = changeColumnOf(engine.table, declared, changeColumn);
  const [start] = await sourcePools().read(sourceId, (run) =>
    run(buildWatchStart(engine.table, column)),
  );
  const value = typeof start?.m === "string" ? start.m : null;
  return JSON.stringify({ value, key: null });
}

/**
 * Upserts the rows whose change column moved past the mark, read live
 * with the builders that watch a client's table (ADR 0031): in the
 * column's order, then the key's, so rows sharing a value page right. A
 * delete is not seen: the periodic full copy finds it.
 */
async function loadIncremental(
  deps: SyncDeps,
  tableId: string,
  sync: { changeColumn: string | null; watermark: string | null },
): Promise<{
  changes: number;
  ids: string[];
  watermark: string;
  events: RowEvent[];
}> {
  const mark = parseMark(sync.watermark);
  if (!sync.changeColumn || !mark) {
    throw new AppError("internal_error", "incremental without a mark");
  }
  const { engine, plain, declared } = await liveTable(deps, tableId);
  const sourceId = engine.table.external?.sourceId;
  if (!sourceId) throw new AppError("internal_error", "native table");
  const column = changeColumnOf(engine.table, declared, sync.changeColumn);
  const columns = copyColumns(engine.table, declared);
  const fields = sealedFields(engine.table).map((item) => item.name);
  const keyed = (engine.table.external?.key.length ?? 0) > 0;
  const keySize = engine.table.external?.key.length ?? 0;
  let at: SyncMark = mark;
  const changed: string[] = [];
  for (;;) {
    const page = await sourcePools().read(sourceId, (run) =>
      run(
        buildWatchPage(
          engine.table,
          column,
          at.value === null ? null : { value: at.value, key: at.key },
          PAGE,
        ),
      ),
    );
    if (page.length === 0) break;
    const ids = page.map((row) => String(row.id));
    const rows = await readTransaction(deps.db, plain, (run) =>
      run(
        buildReadRows(plain, {
          fields,
          rowIds: ids,
          limit: ids.length,
          timeZone: "UTC",
        }),
      ),
    );
    if (rows.length > 0) {
      await runStatement(
        deps.db,
        buildCopyUpsert(
          tableId,
          columns,
          rows.map((row) => {
            const id = String(row.id);
            return copyRow(
              columns,
              row,
              keyed ? keyValues(engine.table, id) : [],
            );
          }),
        ),
      );
    }
    changed.push(...ids);
    const last = page.at(-1);
    if (last) {
      at = { value: String(last.m), key: keyOf(last, keySize) };
    }
    if (page.length < PAGE) break;
    if (changed.length > SYNC_ROW_LIMIT) {
      throw new AppError("source_sync_too_large");
    }
  }
  const when = new Date().toISOString();
  const events: RowEvent[] =
    changed.length === 0
      ? []
      : changed.length <= EVENT_LIMIT
        ? changed.map((rowId) => ({
            tableId,
            event: "update" as const,
            rowId,
            source: "external",
            at: when,
          }))
        : [
            {
              tableId,
              event: "update" as const,
              count: changed.length,
              source: "external",
              at: when,
            },
          ];
  return {
    changes: changed.length,
    ids: changed,
    watermark: JSON.stringify(at),
    events,
  };
}

async function loadNext(
  deps: SyncDeps,
  tableId: string,
): Promise<{ columns: CopyColumn[]; rows: number }> {
  const { engine, plain, declared } = await liveTable(deps, tableId);
  const columns = copyColumns(engine.table, declared);
  const fields = sealedFields(engine.table).map((column) => column.name);
  const keyed = (engine.table.external?.key.length ?? 0) > 0;
  for (const statement of buildCopyCreate(tableId, columns)) {
    await runStatement(deps.db, statement);
  }
  let read = 0;
  for (let offset = 0; ; offset += PAGE) {
    const page = await readTransaction(deps.db, plain, (run) =>
      run(
        buildReadRows(plain, { fields, offset, limit: PAGE, timeZone: "UTC" }),
      ),
    );
    if (page.length === 0) break;
    read += page.length;
    if (read > SYNC_ROW_LIMIT) throw new AppError("source_sync_too_large");
    await runStatement(
      deps.db,
      buildCopyInsert(
        tableId,
        columns,
        page.map((row) => {
          const id = String(row.id);
          return copyRow(
            columns,
            row,
            keyed ? keyValues(engine.table, id) : [],
          );
        }),
      ),
    );
    if (page.length < PAGE) break;
  }
  return { columns, rows: read };
}

/** What differs between the current copy and the next, on their common columns. */
async function diffCopies(
  db: Database,
  tableId: string,
  before: ReadonlyArray<{ name: string }>,
  after: readonly CopyColumn[],
): Promise<Diff> {
  const known = new Set(before.map((column) => column.name));
  const common = after
    .map((column) => column.name)
    .filter((name) => known.has(name));
  const rows = await runStatement(
    db,
    buildCopyDiff(tableId, common, EVENT_LIMIT + 1),
  );
  const counts = new Map<Change["op"], number>();
  for (const row of rows) {
    counts.set(row.op as Change["op"], Number(row.count));
  }
  return {
    changes: rows.map((row) => ({
      op: row.op as Change["op"],
      id: String(row.id),
    })),
    counts,
  };
}

/**
 * Refreshes one synced table, and says in how many seconds the next one
 * runs, or null when the table is no longer synced. Two refreshes of a
 * table never run at once: the second waits for the next turn.
 */
export async function runSync(
  deps: SyncDeps,
  tableId: string,
): Promise<number | null> {
  return deps.db.connection().execute(async (conn) => {
    const { rows } = await sql<{ locked: boolean }>`
      select pg_try_advisory_lock(hashtext(${`ag_sync:${tableId}`})) as "locked"
    `.execute(conn);
    if (!rows[0]?.locked) return null;
    try {
      return await refresh(deps, tableId);
    } finally {
      await sql`select pg_advisory_unlock(hashtext(${`ag_sync:${tableId}`}))`.execute(
        conn,
      );
    }
  });
}

async function refresh(
  deps: SyncDeps,
  tableId: string,
): Promise<number | null> {
  const sync = await deps.db
    .selectFrom("externalSyncs as s")
    .innerJoin("dataTables as t", "t.id", "s.tableId")
    .select([
      "s.intervalMinutes",
      "s.columns",
      "s.version",
      "s.syncMode",
      "s.changeColumn",
      "s.watermark",
      "s.lastFullAt",
      "s.refreshCount",
      "s.fullEvery",
      "t.baseId",
      "t.deletedAt",
    ])
    .where("s.tableId", "=", tableId)
    .executeTakeFirst();
  // A table in the trash, or read live again: no next refresh.
  if (!sync || sync.deletedAt !== null) return null;
  const interval = sync.intervalMinutes * 60;
  const started = Date.now();
  const dueFull = incrementalDueFull(sync);
  if (!dueFull) {
    let incr: Awaited<ReturnType<typeof loadIncremental>>;
    try {
      incr = await loadIncremental(deps, tableId, sync);
    } catch (error) {
      const code = error instanceof AppError ? error.code : "internal_error";
      if (!(error instanceof AppError)) deps.log(error, "external sync failed");
      // A pass that fails starts over from a full copy, which takes its
      // mark again: an error never freezes the copy.
      await deps.db
        .updateTable("externalSyncs")
        .set({ errorCode: code, errorAt: new Date(), watermark: null })
        .where("tableId", "=", tableId)
        .execute();
      return Math.min(interval, RETRY_SECONDS);
    }
    const moved = await deps.db.transaction().execute(async (tx) => {
      const result = await tx
        .updateTable("externalSyncs")
        .set({
          syncedAt: new Date(),
          durationMs: Date.now() - started,
          changes: incr.changes,
          watermark: incr.watermark,
          refreshCount: sync.refreshCount + 1,
          errorCode: null,
          errorAt: null,
          version: sync.version + 1,
        })
        .where("tableId", "=", tableId)
        .where("version", "=", sync.version)
        .executeTakeFirst();
      // Read live again, or its settings changed meanwhile: the next turn.
      if (result.numUpdatedRows === 0n) return false;
      for (const event of incr.events) {
        await addJob(tx, TASKS.rowEvents, { event }, { maxAttempts: 10 });
      }
      return true;
    });
    if (!moved || incr.ids.length === 0) return interval;
    const log = (error: unknown) => deps.log(error, "realtime publish failed");
    if (incr.ids.length > EVENT_LIMIT) {
      await publishRows(deps.bus, tableId, "refresh", [], log);
    } else {
      await announceRows(
        { db: deps.db, bus: deps.bus, log: deps.log },
        tableId,
        "update",
        incr.ids,
      );
    }
    if (deps.seals) {
      try {
        await checkSeals(deps.seals, { tableId, rowIds: incr.ids });
      } catch (error) {
        deps.log(error, "seal check failed");
      }
    }
    return interval;
  }
  // An incremental table takes its mark before the copy reads the rows: a
  // change made while it reads is read again by the next pass.
  let mark: string | null = null;
  if (sync.syncMode === "incremental" && sync.changeColumn) {
    try {
      mark = await startMark(deps, tableId, sync.changeColumn);
    } catch (error) {
      deps.log(error, "external sync mark failed");
    }
  }
  let loaded: { columns: CopyColumn[]; rows: number };
  let diff: Diff | null = null;
  try {
    loaded = await loadNext(deps, tableId);
    if (sync.columns) {
      diff = await diffCopies(deps.db, tableId, sync.columns, loaded.columns);
    }
  } catch (error) {
    const code = error instanceof AppError ? error.code : "internal_error";
    if (!(error instanceof AppError)) deps.log(error, "external sync failed");
    await dropNext(deps.db, tableId);
    await deps.db
      .updateTable("externalSyncs")
      .set({ errorCode: code, errorAt: new Date() })
      .where("tableId", "=", tableId)
      .execute();
    return Math.min(interval, RETRY_SECONDS);
  }
  const changes = diff?.changes ?? [];
  const count = totalOf(diff);
  const swapped = await deps.db.transaction().execute(async (tx) => {
    const moved = await tx
      .updateTable("externalSyncs")
      .set({
        columns: loaded.columns.map(({ name, type }) => ({ name, type })),
        syncedAt: new Date(),
        rowCount: String(loaded.rows),
        durationMs: Date.now() - started,
        changes: count,
        errorCode: null,
        errorAt: null,
        version: sync.version + 1,
        lastFullAt: new Date(),
        refreshCount: 0,
        watermark: mark,
      })
      .where("tableId", "=", tableId)
      .where("version", "=", sync.version)
      .executeTakeFirst();
    // Read live again, or its interval changed meanwhile: the next turn.
    if (moved.numUpdatedRows === 0n) return false;
    for (const statement of buildCopySwap(tableId, loaded.columns)) {
      await runStatement(tx, statement);
    }
    // The first copy only takes its bearings, as a first watch check does.
    if (diff) {
      for (const event of eventsOf(tableId, diff)) {
        await addJob(tx, TASKS.rowEvents, { event }, { maxAttempts: 10 });
      }
    }
    return true;
  });
  if (!swapped) {
    await dropNext(deps.db, tableId);
    return interval;
  }
  const log = (error: unknown) => deps.log(error, "realtime publish failed");
  if (!sync.columns || count > EVENT_LIMIT) {
    // A first copy changes where the table is read: grids read it again.
    if (!sync.columns) await publishCatalog(deps.bus, sync.baseId, log);
    await publishRows(deps.bus, tableId, "refresh", [], log);
  } else {
    for (const op of ["insert", "update", "delete"] as const) {
      const rowIds = changes
        .filter((change) => change.op === op)
        .map((change) => change.id);
      if (rowIds.length > 0) {
        await announceRows(
          { db: deps.db, bus: deps.bus, log: deps.log },
          tableId,
          op,
          rowIds,
        );
      }
    }
  }
  if (deps.seals && changes.length > 0) {
    try {
      await checkSeals(deps.seals, {
        tableId,
        rowIds: changes
          .filter((change) => change.op !== "insert")
          .map((change) => change.id),
      });
    } catch (error) {
      deps.log(error, "seal check failed");
    }
  }
  return interval;
}

/** Drops a table's copies once it is read live again, if it still is. */
export async function dropUnusedCopy(
  db: Database,
  tableId: string,
): Promise<void> {
  const synced = await db
    .selectFrom("externalSyncs")
    .select("tableId")
    .where("tableId", "=", tableId)
    .executeTakeFirst();
  if (synced) return;
  for (const statement of buildCopyDrop(tableId)) {
    await runStatement(db, statement);
  }
}

/**
 * Every synced table has a refresh queued, after a restart or a failure;
 * copies whose table left AnyGridDB are dropped.
 */
export async function ensureSyncs(db: Database): Promise<void> {
  const synced = await db
    .selectFrom("externalSyncs as s")
    .innerJoin("dataTables as t", "t.id", "s.tableId")
    .select(["s.tableId", "t.deletedAt"])
    .execute();
  for (const { tableId, deletedAt } of synced) {
    if (deletedAt === null) {
      await queueSync(db, tableId, 0, "preserve_run_at");
    }
  }
  // A table purged from the trash takes its synced settings with it: its
  // copy is dropped here. One read live again waits for its own job.
  const { rows } = await sql<{ name: string }>`
    select c.tablename as "name" from pg_tables c
    where c.schemaname = ${SYNC_SCHEMA}
      and not exists (
        select 1 from data_tables t
        where c.tablename in (
          't_' || replace(t.id::text, '-', ''),
          'n_' || replace(t.id::text, '-', '')
        )
      )
  `.execute(db);
  for (const { name } of rows) {
    await sql`drop table if exists ${sql.id(SYNC_SCHEMA, name)}`.execute(db);
  }
}
