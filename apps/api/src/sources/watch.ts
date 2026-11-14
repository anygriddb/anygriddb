/**
 * Changes other applications make in a client's tables (ADRs 0006, 0031).
 *
 * An administrator chooses how a table is watched: a column the client's
 * database sets on every change, or SQL Server's Change Tracking. A job
 * checks each watched table on its interval, from a cursor kept in
 * AnyGridDB's database, and tells what changed:
 *
 * - open grids, which read those rows again with their own rights;
 * - webhooks and automations, through the same row events as AnyGridDB's
 *   own writes, from the source `external`.
 *
 * A check moves its cursor and queues its events in one transaction of
 * AnyGridDB's database, guarded by a version: two checks of one table
 * never both count. A row AnyGridDB itself wrote meanwhile already sent
 * its events, and is left out.
 */
import {
  AppError,
  buildChangeTracking,
  buildChangeVersion,
  buildWatchPage,
  buildWatchStart,
  buildWatchWindow,
  type EngineCatalog,
  type RowEvent,
  watchKind,
  type WatchColumn,
} from "@anygriddb/core";
import type { Database, ExternalWatchMethod } from "@anygriddb/db";
import { withAudit } from "../data/audit-context.js";
import { announceRows } from "../data/announce.js";
import { loadEngine } from "../data/engine.js";
import { addJob, TASKS, type SqlExecutor } from "../queue/jobs.js";
import type { Bus } from "../realtime/bus.js";
import { publishRows } from "../realtime/channels.js";
import { sourcePools, type Run } from "./pools.js";
import { sourceTables, type SourceDeps } from "./sources.js";
import { checkSeals, type SealDeps } from "./statuses.js";
import type { SourceTable } from "./types.js";

/** Rows a check reads past its cursor; more wait for the next check, soon. */
const PAGE = 1_000;
/** How far behind a date and time a check reads again, for late commits. */
const LOOKBACK_SECONDS = 120;
/** Rows in that window a check compares; past it, the window is skipped. */
const WINDOW_LIMIT = 2_000;
/** Row events one check sends; past it, one event per kind with a count. */
const EVENT_LIMIT = 200;
/** A check that left rows behind runs again after this. */
const CATCH_UP_SECONDS = 1;
/** Rows AnyGridDB wrote this long before a check's start are its own. */
const OWN_WRITES_MARGIN_MS = 10_000;

type WatchMethod = ExternalWatchMethod;

type WatchInput = {
  tableId: string;
  method: WatchMethod | null;
  column?: string | undefined;
  intervalSeconds: number;
};

type Change = { op: "insert" | "update" | "delete"; id: string };

/** Where a check of a column stands. */
type ColumnCursor = {
  /** The column's value at the last row read, as the engine writes it. */
  at: string | null;
  /** That row's key, to page past rows sharing the value. */
  key: string[] | null;
  /** The highest key, when it is one whole number: a row past it is new. */
  top: string | null;
  /** Rows read within the look-back window: their id and value. */
  seen: Record<string, string>;
};

/** Where a Change Tracking check stands. */
type VersionCursor = {
  version: string;
  /** Inside the changes since `version`, when one check could not read them all. */
  resume: { version: string; key: string[] } | null;
};

function watchJobKey(tableId: string): string {
  return `external_watch:${tableId}`;
}

/** Queues the table's next check, replacing a queued one. */
export async function queueWatch(
  executor: SqlExecutor,
  tableId: string,
  delaySeconds: number,
  mode: "replace" | "preserve_run_at" = "replace",
): Promise<void> {
  await addJob(
    executor,
    TASKS.externalWatch,
    { tableId },
    {
      runAt: new Date(Date.now() + delaySeconds * 1000),
      jobKey: watchJobKey(tableId),
      jobKeyMode: mode,
      maxAttempts: 1,
    },
  );
}

/** The columns a table's changes can be told by, as the admin page offers them. */
export function watchColumns(
  engine: string,
  table: SourceTable,
): Array<{ name: string; type: string }> {
  const dialect = engine as Parameters<typeof watchKind>[0];
  return table.columns
    .filter((column) => watchKind(dialect, column.type) !== null)
    .map((column) => ({ name: column.name, type: column.type }));
}

/**
 * Sets how a client's table is watched, after reading again what its
 * source's account sees: the column must tell changes, Change Tracking
 * must be on and readable. Null stops watching.
 */
export async function setTableWatch(
  deps: SourceDeps,
  actorId: string,
  input: WatchInput,
): Promise<void> {
  const table = await deps.db
    .selectFrom("dataTables as t")
    .innerJoin("sources as s", "s.id", "t.sourceId")
    .select([
      "t.id",
      "t.sourceId",
      "t.externalSchema",
      "t.externalName",
      "s.engine",
    ])
    .where("t.id", "=", input.tableId)
    .where("t.storage", "=", "external")
    .where("t.deletedAt", "is", null)
    .executeTakeFirst();
  if (!table?.sourceId) throw new AppError("unknown_table");
  if (input.method !== null) {
    // A synced table's refreshes tell its changes (ADR 0034).
    const synced = await deps.db
      .selectFrom("externalSyncs")
      .select("tableId")
      .where("tableId", "=", table.id)
      .executeTakeFirst();
    if (synced) throw new AppError("external_table_synced");
    const found = (await sourceTables(deps, table.sourceId)).find(
      (item) =>
        item.schema === table.externalSchema &&
        item.name === table.externalName,
    );
    if (!found) throw new AppError("source_schema_changed");
    if (found.primaryKey.length === 0) {
      throw new AppError("external_table_no_key");
    }
    if (input.method === "column") {
      const column = found.columns.find((item) => item.name === input.column);
      if (!column || watchKind(table.engine, column.type) === null) {
        throw new AppError("source_watch_column", input.column);
      }
    } else if (table.engine !== "sqlserver" || !found.changeTracking) {
      throw new AppError("source_watch_unavailable");
    }
  }
  await withAudit(
    deps.db,
    { userId: actorId, tableId: table.id, source: "web" },
    async (tx) => {
      if (input.method === null) {
        await tx
          .deleteFrom("externalWatches")
          .where("tableId", "=", table.id)
          .execute();
        return;
      }
      const settings = {
        method: input.method,
        columnName: input.method === "column" ? (input.column ?? null) : null,
        intervalSeconds: input.intervalSeconds,
      };
      await tx
        .insertInto("externalWatches")
        .values({ tableId: table.id, ...settings, updatedBy: actorId })
        .onConflict((conflict) =>
          conflict.column("tableId").doUpdateSet((eb) => ({
            ...settings,
            // Another method or column starts again from where it is now.
            cursor: null,
            version: eb("externalWatches.version", "+", 1),
            errorCode: null,
            errorAt: null,
            updatedBy: actorId,
            updatedAt: new Date(),
          })),
        )
        .execute();
      await queueWatch(tx, table.id, 0);
    },
  );
}

/** A value an engine gave as text, or a number. */
function text(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint")
    return String(value);
  return null;
}

/** The key's columns of a row the watch builders read, as text. */
export function keyOf(row: Record<string, unknown>, size: number): string[] {
  return Array.from(
    { length: size },
    (_, index) => text(row[`k${String(index)}`]) ?? "",
  );
}

/** True when `id` names a whole number past `top`: a row added since. */
function pastTop(id: string, top: string | null): boolean {
  if (top === null || !/^-?\d{1,30}$/.test(id) || !/^-?\d{1,30}$/.test(top)) {
    return false;
  }
  return BigInt(id) > BigInt(top);
}

function higher(left: string | null, right: string): string | null {
  if (!/^-?\d{1,30}$/.test(right)) return left;
  if (left === null || !/^-?\d{1,30}$/.test(left)) return right;
  return BigInt(right) > BigInt(left) ? right : left;
}

type CheckResult<C> = {
  cursor: C;
  changes: Change[];
  /** Rows left past this check's page: check again soon. */
  more: boolean;
  /** Changes were lost: open grids read the table again. */
  refresh: boolean;
  /** Something to tell administrators, not an error of the check. */
  note: string | null;
};

async function checkColumn(
  run: Run,
  engine: EngineCatalog,
  column: WatchColumn,
  stored: ColumnCursor | null,
): Promise<CheckResult<ColumnCursor>> {
  const table = engine.table;
  const kind = watchKind(table.external?.dialect ?? "postgres", column.type);
  const keySize = table.external?.key.length ?? 0;
  const window = async (at: string) => {
    if (kind !== "time") return null;
    const rows = await run(
      buildWatchWindow(table, column, at, LOOKBACK_SECONDS, WINDOW_LIMIT + 1),
    );
    return rows.length > WINDOW_LIMIT ? null : rows;
  };
  if (!stored) {
    // The first check takes its bearings: what is there is not a change.
    const [start] = await run(buildWatchStart(table, column));
    const at = typeof start?.m === "string" ? start.m : null;
    const seen: Record<string, string> = {};
    for (const row of (at ? await window(at) : null) ?? []) {
      seen[String(row.id)] = String(row.m);
    }
    return {
      cursor: {
        at,
        key: null,
        top: typeof start?.top === "string" ? start.top : null,
        seen,
      },
      changes: [],
      more: false,
      refresh: false,
      note: null,
    };
  }
  const page = await run(
    buildWatchPage(
      table,
      column,
      stored.at === null ? null : { value: stored.at, key: stored.key },
      PAGE,
    ),
  );
  const more = page.length >= PAGE;
  // Late commits land behind the cursor; not while catching up.
  const late =
    stored.at !== null && stored.key === null ? await window(stored.at) : null;
  const changes: Change[] = [];
  // The window, read again, holds every row it still has to compare; while
  // paging or past its limit, the rows already told stay known instead.
  const seen: Record<string, string> =
    late === null && Object.keys(stored.seen).length <= WINDOW_LIMIT * 2
      ? { ...stored.seen }
      : {};
  let top = stored.top;
  for (const row of late ?? []) {
    const id = String(row.id);
    const value = String(row.m);
    seen[id] = value;
    if (stored.seen[id] !== value) {
      changes.push({ op: pastTop(id, stored.top) ? "insert" : "update", id });
    }
  }
  for (const row of page) {
    const id = String(row.id);
    seen[id] = String(row.m);
    changes.push({ op: pastTop(id, stored.top) ? "insert" : "update", id });
    top = higher(top, id);
  }
  const last = page.at(-1);
  return {
    cursor: {
      at: last ? String(last.m) : stored.at,
      // Paging inside a value: the next check goes on from this key.
      key: more && last ? keyOf(last, keySize) : null,
      top,
      seen,
    },
    changes: unique(changes),
    more,
    refresh: false,
    note: null,
  };
}

async function checkChangeTracking(
  run: Run,
  engine: EngineCatalog,
  stored: VersionCursor | null,
): Promise<CheckResult<VersionCursor>> {
  const table = engine.table;
  const keySize = table.external?.key.length ?? 0;
  const [now] = await run(buildChangeVersion(table));
  const current = text(now?.v);
  if (current === null) throw new AppError("source_watch_unavailable");
  if (!stored) {
    return {
      cursor: { version: current, resume: null },
      changes: [],
      more: false,
      refresh: false,
      note: null,
    };
  }
  const oldest = text(now?.min);
  if (oldest !== null && BigInt(stored.version) < BigInt(oldest)) {
    // SQL Server dropped changes it no longer keeps: start again from now.
    return {
      cursor: { version: current, resume: null },
      changes: [],
      more: false,
      refresh: true,
      note: "source_changes_expired",
    };
  }
  const rows = await run(
    buildChangeTracking(table, stored.version, current, stored.resume, PAGE),
  );
  const more = rows.length >= PAGE;
  const last = rows.at(-1);
  const changes = rows.map((row): Change => ({
    op: row.op === "I" ? "insert" : row.op === "D" ? "delete" : "update",
    id: String(row.id),
  }));
  return {
    cursor:
      more && last
        ? {
            version: stored.version,
            resume: { version: String(last.v), key: keyOf(last, keySize) },
          }
        : { version: current, resume: null },
    changes: unique(changes),
    more,
    refresh: false,
    note: null,
  };
}

/** One change per row: the last one read. */
function unique(changes: readonly Change[]): Change[] {
  const byId = new Map<string, Change>();
  for (const change of changes) {
    const before = byId.get(change.id);
    // Added then changed within one check is still an addition.
    byId.set(
      change.id,
      before?.op === "insert" && change.op === "update" ? before : change,
    );
  }
  return [...byId.values()];
}

/** Row events for webhooks and automations: one per row, or a count past the limit. */
function eventsOf(tableId: string, changes: readonly Change[]): RowEvent[] {
  const at = new Date().toISOString();
  if (changes.length <= EVENT_LIMIT) {
    return changes.map((change) => ({
      tableId,
      event: change.op,
      rowId: change.id,
      source: "external",
      at,
    }));
  }
  const counts = new Map<Change["op"], number>();
  for (const change of changes) {
    counts.set(change.op, (counts.get(change.op) ?? 0) + 1);
  }
  return [...counts].map(([op, count]) => ({
    tableId,
    event: op,
    count,
    source: "external",
    at,
  }));
}

type WatchDeps = {
  db: Database;
  bus: Bus;
  log: (error: unknown, message: string) => void;
  /** Compares at once the sealed rows a check found changed (ADR 0033). */
  seals?: SealDeps;
};

/**
 * Checks one table, and says in how many seconds the next check runs, or
 * null when the table is no longer watched.
 */
export async function runWatch(
  deps: WatchDeps,
  tableId: string,
): Promise<number | null> {
  const watch = await deps.db
    .selectFrom("externalWatches as w")
    .innerJoin("dataTables as t", "t.id", "w.tableId")
    .select([
      "w.method",
      "w.columnName",
      "w.intervalSeconds",
      "w.cursor",
      "w.version",
      "w.checkedAt",
      "t.sourceId",
      "t.deletedAt",
    ])
    .where("w.tableId", "=", tableId)
    .executeTakeFirst();
  // A table in the trash, or no longer watched: no next check.
  if (!watch?.sourceId || watch.deletedAt !== null) return null;
  const started = new Date();
  const interval = watch.intervalSeconds;
  let result: CheckResult<ColumnCursor | VersionCursor>;
  try {
    const { engine } = await loadEngine(deps.db, tableId, () => true);
    const physical =
      watch.method === "column"
        ? engine.table.columns.find(
            (item) => item.physical?.name === watch.columnName,
          )?.physical
        : undefined;
    const column: WatchColumn | null =
      watch.method === "column" && watch.columnName
        ? {
            name: watch.columnName,
            type:
              physical?.type ??
              (await columnType(deps.db, tableId, watch.columnName)),
          }
        : null;
    result = await sourcePools().read<
      CheckResult<ColumnCursor | VersionCursor>
    >(watch.sourceId, (run) =>
      column
        ? checkColumn(run, engine, column, watch.cursor as ColumnCursor | null)
        : checkChangeTracking(
            run,
            engine,
            watch.cursor as VersionCursor | null,
          ),
    );
  } catch (error) {
    const code = error instanceof AppError ? error.code : "internal_error";
    if (!(error instanceof AppError)) deps.log(error, "external watch failed");
    await deps.db
      .updateTable("externalWatches")
      .set({ errorCode: code, errorAt: new Date() })
      .where("tableId", "=", tableId)
      .execute();
    // A source that is down is asked again, less often.
    return Math.min(interval * 4, 600);
  }

  // Rows AnyGridDB wrote meanwhile already sent their own events.
  const since = new Date(
    (watch.checkedAt ?? started).getTime() - OWN_WRITES_MARGIN_MS,
  );
  const ids = result.changes.map((change) => change.id);
  const own = new Set<string>();
  for (let start = 0; start < ids.length; start += 500) {
    const chunk = ids.slice(start, start + 500);
    const written = await deps.db
      .selectFrom("externalWrites")
      .select("rowId")
      .where("tableId", "=", tableId)
      .where("requestedAt", ">=", since)
      .where("rowId", "in", chunk)
      .execute();
    for (const row of written) if (row.rowId) own.add(row.rowId);
  }
  const changes = result.changes.filter((change) => !own.has(change.id));

  const counted = await deps.db.transaction().execute(async (tx) => {
    const moved = await tx
      .updateTable("externalWatches")
      .set({
        cursor: result.cursor,
        version: watch.version + 1,
        checkedAt: started,
        changes: changes.length,
        ...(changes.length > 0 ? { changedAt: started } : {}),
        errorCode: result.note,
        errorAt: result.note ? started : null,
      })
      .where("tableId", "=", tableId)
      .where("version", "=", watch.version)
      .executeTakeFirst();
    // Another check of this table counted first, or the settings changed.
    if (moved.numUpdatedRows === 0n) return false;
    for (const event of eventsOf(tableId, changes)) {
      await addJob(tx, TASKS.rowEvents, { event }, { maxAttempts: 10 });
    }
    return true;
  });
  if (!counted) return interval;

  const log = (error: unknown, message: string) => deps.log(error, message);
  if (result.refresh) {
    await publishRows(deps.bus, tableId, "refresh", [], (error) =>
      log(error, "realtime publish failed"),
    );
  }
  for (const op of ["insert", "update", "delete"] as const) {
    const rowIds = changes
      .filter((change) => change.op === op)
      .map((change) => change.id);
    if (rowIds.length > 0) {
      await announceRows(
        { db: deps.db, bus: deps.bus, log },
        tableId,
        op,
        rowIds,
      );
    }
  }
  if (deps.seals && changes.length > 0) {
    try {
      await checkSeals(deps.seals, {
        tableId,
        rowIds: changes.map((change) => change.id),
      });
    } catch (error) {
      log(error, "seal check failed");
    }
  }
  return result.more ? CATCH_UP_SECONDS : interval;
}

async function columnType(
  db: Database,
  tableId: string,
  physicalName: string,
): Promise<string> {
  const row = await db
    .selectFrom("dataColumns")
    .select("externalType")
    .where("tableId", "=", tableId)
    .where("physicalName", "=", physicalName)
    .executeTakeFirst();
  if (!row?.externalType) throw new AppError("source_watch_column");
  return row.externalType;
}

/** Every watched table has a check queued: after a restart, or a failed job. */
export async function ensureWatches(db: Database): Promise<void> {
  const watched = await db
    .selectFrom("externalWatches as w")
    .innerJoin("dataTables as t", "t.id", "w.tableId")
    .select("w.tableId")
    .where("t.deletedAt", "is", null)
    .execute();
  for (const { tableId } of watched) {
    await queueWatch(db, tableId, 0, "preserve_run_at");
  }
}
