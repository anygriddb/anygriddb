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
  buildCopySwap,
  buildReadRows,
  copyColumns,
  copyRow,
  type CopyColumn,
  keyValues,
  MAX_READ_LIMIT,
  type RowEvent,
  sealedFields,
  SYNC_SCHEMA,
} from "@anygriddb/core";
import { runStatement, type Database } from "@anygriddb/db";
import { sql } from "kysely";
import { withAudit } from "../data/audit-context.js";
import { announceRows } from "../data/announce.js";
import { loadEngine } from "../data/engine.js";
import { readTransaction } from "../data/rows.js";
import { addJob, TASKS, type SqlExecutor } from "../queue/jobs.js";
import type { Bus } from "../realtime/bus.js";
import { publishCatalog, publishRows } from "../realtime/channels.js";
import { checkSeals, type SealDeps } from "./statuses.js";

/** Rows read from the client's table at a time. */
const PAGE = Math.min(1_000, MAX_READ_LIMIT);
/** A copy stops here: past it, the table is better read live. */
export const SYNC_ROW_LIMIT = 1_000_000;
/** Changes one refresh tells row by row; past it, one event per kind. */
const EVENT_LIMIT = 200;
/** A refresh that failed is tried again this soon, at most. */
const RETRY_SECONDS = 300;
/** A copy no longer read is dropped this long after: reads under way end. */
const DROP_AFTER_MS = 60_000;

export type SyncInput = {
  tableId: string;
  /** Null reads the table live again, and drops its copy. */
  intervalMinutes: number | null;
};

function syncJobKey(tableId: string): string {
  return `external_sync:${tableId}`;
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
      await tx
        .insertInto("externalSyncs")
        .values({
          tableId: table.id,
          intervalMinutes: input.intervalMinutes,
          updatedBy: actorId,
        })
        .onConflict((conflict) =>
          conflict.column("tableId").doUpdateSet({
            intervalMinutes: input.intervalMinutes ?? 15,
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

export type SyncDeps = {
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
async function loadNext(
  deps: SyncDeps,
  tableId: string,
): Promise<{ columns: CopyColumn[]; rows: number }> {
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
  const columns = copyColumns(engine.table, declared);
  const fields = sealedFields(engine.table).map((column) => column.name);
  // A link is copied as the key it holds: its foreign key is read as a
  // plain column, without joining the other table for labels.
  const plain = {
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
      "t.baseId",
      "t.deletedAt",
    ])
    .where("s.tableId", "=", tableId)
    .executeTakeFirst();
  // A table in the trash, or read live again: no next refresh.
  if (!sync || sync.deletedAt !== null) return null;
  const interval = sync.intervalMinutes * 60;
  const started = Date.now();
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
