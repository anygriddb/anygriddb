/**
 * Statuses and signatures on a client's rows (ADRs 0007, 0033).
 *
 * A client's table has no status column: the status of a row that left
 * draft lives in AnyGridDB's database, named by the row's key. The
 * workflow is the one of AnyGridDB's own rows: submit, lock, sign,
 * unlock. AnyGridDB refuses its own writes to a locked or signed row;
 * other applications are not refused, so locking seals the row: its
 * stored values and their SHA-256 fingerprint are kept, and a job compares
 * the row with them to detect and tell a change made elsewhere.
 *
 * A lock waits for the writes under way: a write records its intent, then
 * reads the row's status (`assertUnsealed`); the lock commits the status
 * first, waits for every write recorded before, and only then reads the
 * row. Nothing holds a connection while a client's transaction runs.
 */
import { createHash } from "node:crypto";
import {
  AppError,
  assertStatusTransition,
  type AuditRole,
  type EngineCatalog,
  type RowEvent,
  sealDrift,
  sealedFields,
  sealRow,
  sealText,
} from "@anygriddb/core";
import type { Database, ExternalStatus } from "@anygriddb/db";
import { sql } from "kysely";
import { loadEngine, type TableRow } from "../data/engine.js";
import { liveBase, liveTable } from "../data/live.js";
import { readByIds, type RowRecord } from "../data/rows.js";
import { addJob, TASKS, type SqlExecutor } from "../queue/jobs.js";
import type { NotificationInput } from "../notifications.js";

/** Statuses AnyGridDB refuses its own writes on. */
const SEALED: readonly ExternalStatus[] = ["locked", "signed"];

/** How long a lock waits for writes recorded before it. */
const DRAIN_MS = 30_000;
const DRAIN_STEP_MS = 200;
/** An intent this old with no outcome was cut short: the settle job owns it. */
const STALE_INTENT_MS = 15 * 60_000;
/** Sealed rows one scheduled check compares, the least recently checked first. */
const CHECK_BATCH = 2_000;
/** Rows read from a client's table at a time. */
const CHUNK = 100;

/** The fingerprint of sealed values: the SHA-256 of their canonical text. */
export function fingerprintOf(values: Readonly<Record<string, unknown>>) {
  return createHash("sha256")
    .update(`anygriddb-seal-1\n${sealText(values)}`)
    .digest("hex");
}

/** What a check found differing, as a row carries it to the grid. */
export type Drift = {
  at: string;
  /** The row is gone from the client's table. */
  missing: boolean;
  /** Fields whose value moved, and what they held when sealed. */
  fields: string[];
  sealed: Record<string, unknown>;
};

type StoredDrift = {
  missing?: boolean;
  fields?: string[];
  values?: Record<string, unknown>;
};

function storedDrift(value: unknown): StoredDrift | null {
  return value && typeof value === "object" ? value : null;
}

function chunks<T>(items: readonly T[], size = CHUNK): T[][] {
  const list: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    list.push(items.slice(start, start + size));
  }
  return list;
}

/** Refuses a status on a table whose rows have no key to name them. */
function assertKeyed(table: Pick<TableRow, "storage" | "externalKey">): void {
  if (table.storage !== "external") {
    throw new AppError("internal_error", "native table");
  }
  if ((table.externalKey ?? []).length === 0) {
    throw new AppError("external_table_no_key");
  }
}

/**
 * Refuses a write through AnyGridDB to locked or signed rows. A write
 * calls it before anything, and again once its intent is recorded: a lock
 * that committed in between then refuses it, and one that did not waits
 * for it.
 */
export async function assertUnsealed(
  db: Database,
  tableId: string,
  rowIds: readonly string[],
): Promise<void> {
  for (const chunk of chunks([...new Set(rowIds)], 500)) {
    const sealed = await db
      .selectFrom("externalStatuses")
      .select("rowId")
      .where("tableId", "=", tableId)
      .where("rowId", "in", chunk)
      .where("status", "in", SEALED)
      .executeTakeFirst();
    if (sealed) throw new AppError("row_locked");
  }
}

/**
 * Sets each client row's status (draft when it has none) and returns what
 * the checks found on sealed rows, without the fields `hidden` keeps from
 * the reader. A table without a key has no status at all.
 */
export async function attachExternalStatuses(
  db: Database,
  engine: EngineCatalog,
  rows: RowRecord[],
): Promise<Map<string, Drift>> {
  const drifts = new Map<string, Drift>();
  const table = engine.table;
  if (!table.external || table.external.key.length === 0) return drifts;
  const ids = rows.map((row) => row.id);
  const found = new Map<
    string,
    { status: string; drift: unknown; driftAt: Date | null; sealed: unknown }
  >();
  for (const chunk of chunks(ids, 500)) {
    const states = await db
      .selectFrom("externalStatuses")
      .select(["rowId", "status", "drift", "driftAt", "sealed"])
      .where("tableId", "=", table.id)
      .where("rowId", "in", chunk)
      .execute();
    for (const state of states) found.set(state.rowId, state);
  }
  const hidden = (name: string) =>
    engine.access?.hidden(table.id, name) ?? false;
  for (const row of rows) {
    const state = found.get(row.id);
    row.ag_status = state?.status ?? "draft";
    const drift = storedDrift(state?.drift);
    if (!state || !drift || !state.driftAt) continue;
    const sealed = (state.sealed ?? {}) as Record<string, unknown>;
    const fields = (drift.fields ?? []).filter((name) => !hidden(name));
    drifts.set(row.id, {
      at: state.driftAt.toISOString(),
      missing: drift.missing === true,
      fields,
      sealed: Object.fromEntries(fields.map((name) => [name, sealed[name]])),
    });
  }
  return drifts;
}

type StatusInput = {
  userId: string;
  table: TableRow;
  rowId: string;
  source: string;
  depth: number;
};

type State = {
  status: ExternalStatus;
  version: number;
  fingerprint: string | null;
  sealed: Record<string, unknown> | null;
};

async function readState(
  db: Database,
  tableId: string,
  rowId: string,
): Promise<State | undefined> {
  return db
    .selectFrom("externalStatuses")
    .select(["status", "version", "fingerprint", "sealed"])
    .where("tableId", "=", tableId)
    .where("rowId", "=", rowId)
    .executeTakeFirst();
}

/** The row's sealed values as the client's database holds them now, or null. */
async function readSealed(
  db: Database,
  tableId: string,
  rowId: string,
): Promise<Record<string, unknown> | null> {
  const { engine } = await loadEngine(db, tableId, () => true);
  const fields = sealedFields(engine.table).map((column) => column.name);
  const [row] = await readByIds(db, engine, [rowId], "UTC", fields);
  return row ? sealRow(engine.table, row) : null;
}

/** The `status` event webhooks and automations receive, as from native rows. */
async function queueStatusEvent(
  executor: SqlExecutor,
  input: StatusInput,
): Promise<void> {
  const event: RowEvent = {
    tableId: input.table.id,
    event: "status",
    rowId: input.rowId,
    columns: ["ag_status"],
    actorId: input.userId,
    source: input.source.slice(0, 100),
    ...(input.depth > 0 ? { depth: input.depth } : {}),
    at: new Date().toISOString(),
  };
  await addJob(executor, TASKS.rowEvents, { event }, { maxAttempts: 10 });
}

/** Waits until no write recorded on the row is still under way. */
async function drainWrites(
  db: Database,
  tableId: string,
  rowId: string,
): Promise<void> {
  const until = Date.now() + DRAIN_MS;
  for (;;) {
    const open = await db
      .selectFrom("externalWrites as w")
      .select("w.id")
      .where("w.tableId", "=", tableId)
      .where("w.rowId", "=", rowId)
      .where("w.requestedAt", ">", new Date(Date.now() - STALE_INTENT_MS))
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom("externalWriteSteps as s")
              .select("s.writeId")
              .whereRef("s.writeId", "=", "w.id"),
          ),
        ),
      )
      .executeTakeFirst();
    if (!open || Date.now() >= until) return;
    await new Promise((resolve) => setTimeout(resolve, DRAIN_STEP_MS));
  }
}

/**
 * Submits, locks, or unlocks a client's row; `role` decides which moves
 * are allowed, as on AnyGridDB's own rows.
 */
export async function setExternalStatus(
  db: Database,
  input: StatusInput & {
    role: AuditRole;
    status: "submitted" | "locked" | "draft";
  },
): Promise<void> {
  assertKeyed(input.table);
  const { table, rowId } = input;
  const state = await readState(db, table.id, rowId);
  assertStatusTransition(state?.status ?? "draft", input.status, input.role);
  if (input.status === "submitted") {
    if (!(await readSealed(db, table.id, rowId))) {
      throw new AppError("source_row_missing");
    }
    await db.transaction().execute(async (tx) => {
      const added = await tx
        .insertInto("externalStatuses")
        .values({
          tableId: table.id,
          rowId,
          status: "submitted",
          updatedBy: input.userId,
        })
        .onConflict((conflict) => conflict.doNothing())
        .returning("rowId")
        .executeTakeFirst();
      if (!added) throw new AppError("invalid_status");
      await logEvent(tx, input, "submit", null, null);
      await queueStatusEvent(tx, input);
    });
    return;
  }
  if (!state) throw new AppError("invalid_status");
  if (input.status === "draft") {
    await db.transaction().execute(async (tx) => {
      const removed = await tx
        .deleteFrom("externalStatuses")
        .where("tableId", "=", table.id)
        .where("rowId", "=", rowId)
        .where("version", "=", state.version)
        .executeTakeFirst();
      if (removed.numDeletedRows === 0n) throw new AppError("invalid_status");
      await logEvent(tx, input, "unlock", state.fingerprint, {
        from: state.status,
      });
      await queueStatusEvent(tx, input);
    });
    return;
  }
  await lockRow(db, input, state.version);
}

/**
 * Locks a submitted row in two steps: the status first, so writes from
 * now on are refused; then, once the writes recorded before have
 * finished, the seal of what the row holds.
 */
async function lockRow(
  db: Database,
  input: StatusInput,
  version: number,
): Promise<void> {
  const { table, rowId } = input;
  const fenced = await db
    .updateTable("externalStatuses")
    .set({
      status: "locked",
      sealed: null,
      fingerprint: null,
      sealedAt: null,
      drift: null,
      driftAt: null,
      version: version + 1,
      updatedBy: input.userId,
      updatedAt: new Date(),
    })
    .where("tableId", "=", table.id)
    .where("rowId", "=", rowId)
    .where("version", "=", version)
    .where("status", "=", "submitted")
    .executeTakeFirst();
  if (fenced.numUpdatedRows === 0n) throw new AppError("invalid_status");
  let sealed: Record<string, unknown> | null;
  try {
    await drainWrites(db, table.id, rowId);
    sealed = await readSealed(db, table.id, rowId);
    if (!sealed) throw new AppError("source_row_missing");
  } catch (error) {
    // Back to submitted: the row could not be read, so nothing is sealed.
    await db
      .updateTable("externalStatuses")
      .set({ status: "submitted", version: version + 2 })
      .where("tableId", "=", table.id)
      .where("rowId", "=", rowId)
      .where("version", "=", version + 1)
      .execute();
    throw error;
  }
  const fingerprint = fingerprintOf(sealed);
  await db.transaction().execute(async (tx) => {
    const done = await tx
      .updateTable("externalStatuses")
      .set({
        sealed,
        fingerprint,
        sealedAt: new Date(),
        checkedAt: new Date(),
      })
      .where("tableId", "=", table.id)
      .where("rowId", "=", rowId)
      .where("version", "=", version + 1)
      .where("status", "=", "locked")
      .executeTakeFirst();
    // Unlocked while it waited.
    if (done.numUpdatedRows === 0n) throw new AppError("invalid_status");
    await logEvent(tx, input, "lock", fingerprint, { values: sealed });
    await queueStatusEvent(tx, input);
  });
}

/**
 * Signs a locked client row: the row read again must still hold what was
 * sealed. The signature records the fingerprint of what it signs.
 */
export async function signExternalRow(
  db: Database,
  input: StatusInput & { meaning: string },
): Promise<void> {
  assertKeyed(input.table);
  const { table, rowId } = input;
  const state = await readState(db, table.id, rowId);
  if (state?.status !== "locked" || !state.fingerprint || !state.sealed) {
    throw new AppError("invalid_status");
  }
  const current = await readSealed(db, table.id, rowId);
  if (!current || sealDrift(state.sealed, current).length > 0) {
    // The check records it and tells the owners.
    await queueSealCheck(db, table.id, [rowId]);
    throw new AppError("row_changed_elsewhere");
  }
  const named = await db
    .selectFrom("users")
    .select("displayName")
    .where("id", "=", input.userId)
    .executeTakeFirst();
  if (!named) throw new AppError("no_row");
  const fingerprint = state.fingerprint;
  await db.transaction().execute(async (tx) => {
    const signed = await tx
      .updateTable("externalStatuses")
      .set({
        status: "signed",
        version: state.version + 1,
        updatedBy: input.userId,
        updatedAt: new Date(),
        checkedAt: new Date(),
      })
      .where("tableId", "=", table.id)
      .where("rowId", "=", rowId)
      .where("version", "=", state.version)
      .where("status", "=", "locked")
      .executeTakeFirst();
    if (signed.numUpdatedRows === 0n) throw new AppError("invalid_status");
    await tx
      .insertInto("rowSignatures")
      .values({
        userId: input.userId,
        tableId: table.id,
        recordId: rowId,
        displayName: named.displayName,
        meaning: input.meaning,
        fingerprint,
      })
      .execute();
    await logEvent(tx, input, "sign", fingerprint, { meaning: input.meaning });
    await queueStatusEvent(tx, input);
  });
}

type EventAction =
  "submit" | "lock" | "unlock" | "sign" | "changed" | "restored";

async function logEvent(
  executor: SqlExecutor,
  input: { userId: string | null; table: { id: string }; rowId: string } & {
    source: string;
  },
  action: EventAction,
  fingerprint: string | null,
  detail: unknown,
): Promise<void> {
  await sql`
    insert into external_status_events
      (user_id, table_id, row_id, action, fingerprint, detail, source)
    values (
      ${input.userId}, ${input.table.id}, ${input.rowId}, ${action},
      ${fingerprint}, ${detail === null ? null : JSON.stringify(detail)}::jsonb,
      ${input.source.slice(0, 100)}
    )
  `.execute(executor);
}

/**
 * A row AnyGridDB deleted takes its status with it, as on its own tables:
 * only a submitted one can be, a locked one is refused.
 */
export async function forgetStatuses(
  db: Database,
  tableId: string,
  rowIds: readonly string[],
): Promise<void> {
  for (const chunk of chunks([...new Set(rowIds)], 500)) {
    await db
      .deleteFrom("externalStatuses")
      .where("tableId", "=", tableId)
      .where("rowId", "in", chunk)
      .where("status", "=", "submitted")
      .execute();
  }
}

/** Queues a check of these rows, when some of them are sealed. */
export async function queueSealCheck(
  db: Database,
  tableId: string,
  rowIds: readonly string[],
): Promise<void> {
  const sealed: string[] = [];
  for (const chunk of chunks([...new Set(rowIds)], 500)) {
    const rows = await db
      .selectFrom("externalStatuses")
      .select("rowId")
      .where("tableId", "=", tableId)
      .where("rowId", "in", chunk)
      .where("status", "in", SEALED)
      .execute();
    sealed.push(...rows.map((row) => row.rowId));
  }
  if (sealed.length === 0) return;
  for (const chunk of chunks(sealed, 1_000)) {
    await addJob(
      db,
      TASKS.externalSeals,
      { tableId, rowIds: chunk },
      { maxAttempts: 3 },
    );
  }
}

export type SealDeps = {
  db: Database;
  log: (error: unknown, message: string) => void;
  /** Tells those who locked or signed a row, and the table's owners. */
  notify?: (items: NotificationInput[]) => Promise<unknown>;
  /** Tells open grids which rows' marks moved. */
  announce?: (tableId: string, rowIds: string[]) => Promise<void>;
};

type Sealed = {
  tableId: string;
  rowId: string;
  status: ExternalStatus;
  version: number;
  sealed: Record<string, unknown> | null;
  drift: Record<string, unknown> | null;
};

function sameDrift(left: StoredDrift | null, right: StoredDrift | null) {
  return (
    (left?.missing ?? false) === (right?.missing ?? false) &&
    JSON.stringify(left?.fields ?? []) === JSON.stringify(right?.fields ?? [])
  );
}

/**
 * Compares sealed rows with what the client's database holds: the rows
 * given, or the least recently checked. A row that moved is marked
 * changed, recorded, and told; one that holds its sealed values again is
 * marked restored. A source it cannot reach is tried again next time.
 */
export async function checkSeals(
  deps: SealDeps,
  only?: { tableId: string; rowIds: readonly string[] },
): Promise<number> {
  if (!only) await revertStaleLocks(deps.db);
  let query = deps.db
    .selectFrom("externalStatuses as s")
    .innerJoin("dataTables as t", "t.id", "s.tableId")
    .innerJoin("bases as b", "b.id", "t.baseId")
    .select([
      "s.tableId",
      "s.rowId",
      "s.status",
      "s.version",
      "s.sealed",
      "s.drift",
    ])
    .where("s.status", "in", SEALED)
    .where("s.fingerprint", "is not", null)
    // A table in the trash waits there: its rows are compared once back.
    .where(liveTable("t"))
    .where(liveBase("b"));
  if (only) {
    if (only.rowIds.length === 0) return 0;
    query = query
      .where("s.tableId", "=", only.tableId)
      .where("s.rowId", "in", [...only.rowIds]);
  } else {
    query = query.orderBy(sql`s.checked_at nulls first`).limit(CHECK_BATCH);
  }
  const states: Sealed[] = await query.execute();
  const byTable = new Map<string, Sealed[]>();
  for (const state of states) {
    byTable.set(state.tableId, [...(byTable.get(state.tableId) ?? []), state]);
  }
  let checked = 0;
  for (const [tableId, rows] of byTable) {
    let current: Map<string, Record<string, unknown>>;
    try {
      const { engine } = await loadEngine(deps.db, tableId, () => true);
      const fields = sealedFields(engine.table).map((column) => column.name);
      current = new Map();
      for (const chunk of chunks(rows.map((row) => row.rowId))) {
        const read = await readByIds(deps.db, engine, chunk, "UTC", fields);
        for (const row of read) current.set(row.id, sealRow(engine.table, row));
      }
    } catch (error) {
      if (!(error instanceof AppError && error.code === "unknown_table")) {
        deps.log(error, "seal check failed");
      }
      // Its turn passes: a source that does not answer holds no one up.
      await markChecked(deps.db, tableId, rows);
      continue;
    }
    const moved = await recordFindings(deps, tableId, rows, current);
    checked += rows.length;
    if (moved.length > 0 && deps.announce) {
      await deps.announce(tableId, moved);
    }
  }
  return checked;
}

async function markChecked(
  executor: SqlExecutor,
  tableId: string,
  rows: readonly Sealed[],
): Promise<void> {
  const now = new Date();
  for (const chunk of chunks(
    rows.map((row) => row.rowId),
    500,
  )) {
    await sql`
      update external_statuses set checked_at = ${now}
      where table_id = ${tableId} and row_id in (${sql.join(chunk)})
    `.execute(executor);
  }
}

/** How long a lock may wait for writes and read its row before it is undone. */
const FENCE_TIMEOUT_MS = 5 * 60_000;

/**
 * A lock whose process stopped between taking the status and sealing the
 * row seals nothing: it goes back to submitted, for an owner to lock again.
 */
async function revertStaleLocks(db: Database): Promise<void> {
  await db
    .updateTable("externalStatuses")
    .set((eb) => ({ status: "submitted", version: eb("version", "+", 1) }))
    .where("status", "=", "locked")
    .where("fingerprint", "is", null)
    .where("updatedAt", "<", new Date(Date.now() - FENCE_TIMEOUT_MS))
    .execute();
}

/** Records what one check found; returns the rows whose mark moved. */
async function recordFindings(
  deps: SealDeps,
  tableId: string,
  rows: readonly Sealed[],
  current: ReadonlyMap<string, Record<string, unknown>>,
): Promise<string[]> {
  const now = new Date();
  const moved: Array<{ row: Sealed; drift: StoredDrift | null }> = [];
  for (const row of rows) {
    const values = current.get(row.rowId);
    const fields = values ? sealDrift(row.sealed ?? {}, values) : [];
    const drift: StoredDrift | null = !values
      ? { missing: true, fields: [] }
      : fields.length > 0
        ? {
            fields,
            values: Object.fromEntries(
              fields.map((name) => [name, values[name] ?? null]),
            ),
          }
        : null;
    if (sameDrift(storedDrift(row.drift), drift)) continue;
    moved.push({ row, drift });
  }
  const recorded: typeof moved = [];
  await deps.db.transaction().execute(async (tx) => {
    await markChecked(tx, tableId, rows);
    for (const { row, drift } of moved) {
      // A status that changed since it was read, or a finding another
      // check recorded meanwhile, is left as it is: told once.
      const before = row.drift === null ? null : JSON.stringify(row.drift);
      const updated = await tx
        .updateTable("externalStatuses")
        .set({ drift, driftAt: drift ? now : null })
        .where("tableId", "=", tableId)
        .where("rowId", "=", row.rowId)
        .where("version", "=", row.version)
        .where(sql<boolean>`drift is not distinct from ${before}::jsonb`)
        .executeTakeFirst();
      if (updated.numUpdatedRows === 0n) continue;
      recorded.push({ row, drift });
      await logEvent(
        tx,
        {
          userId: null,
          table: { id: tableId },
          rowId: row.rowId,
          source: "check",
        },
        drift ? "changed" : "restored",
        null,
        drift,
      );
    }
  });
  const changed = recorded.filter((item) => item.drift !== null);
  if (changed.length > 0 && deps.notify) {
    try {
      await deps.notify(
        await recipients(
          deps.db,
          tableId,
          changed.map((item) => item.row),
        ),
      );
    } catch (error) {
      deps.log(error, "seal alert failed");
    }
  }
  return recorded.map((item) => item.row.rowId);
}

/**
 * Who hears that a sealed row changed: whoever last moved its status, its
 * signers, and the table's owners. `notify` keeps those who can read it.
 */
async function recipients(
  db: Database,
  tableId: string,
  rows: readonly Sealed[],
): Promise<NotificationInput[]> {
  const table = await db
    .selectFrom("dataTables")
    .select(["id", "baseId"])
    .where("id", "=", tableId)
    .executeTakeFirst();
  if (!table) return [];
  const owners = await db
    .selectFrom("roleBindings")
    .select("userId")
    .where("role", "=", "owner")
    .where((eb) =>
      eb.or([
        eb.and([eb("scope", "=", "base"), eb("scopeId", "=", table.baseId)]),
        eb.and([eb("scope", "=", "table"), eb("scopeId", "=", table.id)]),
      ]),
    )
    .execute();
  const ids = rows.map((row) => row.rowId);
  const movers = await db
    .selectFrom("externalStatuses")
    .select(["rowId", "updatedBy"])
    .where("tableId", "=", tableId)
    .where("rowId", "in", ids)
    .execute();
  const signers = await db
    .selectFrom("rowSignatures")
    .select(["recordId", "userId"])
    .where("tableId", "=", tableId)
    .where("recordId", "in", ids)
    .execute();
  const items: NotificationInput[] = [];
  for (const row of rows) {
    const people = new Set(owners.map((owner) => owner.userId));
    for (const mover of movers) {
      if (mover.rowId === row.rowId && mover.updatedBy) {
        people.add(mover.updatedBy);
      }
    }
    for (const signer of signers) {
      if (signer.recordId === row.rowId) people.add(signer.userId);
    }
    for (const userId of people) {
      items.push({
        userId,
        kind: "row_changed",
        tableId,
        rowId: row.rowId,
        data: { row: row.rowId },
      });
    }
  }
  return items;
}

/** A client row's status trail, as its history shows it beside the writes. */
export async function readStatusEvents(
  db: Database,
  tableId: string,
  rowId: string,
  hidden: (column: string) => boolean = () => false,
) {
  const events = await db
    .selectFrom("externalStatusEvents as e")
    .leftJoin("users as u", "u.id", "e.userId")
    .select([
      "e.at",
      "e.userId",
      "u.displayName",
      "e.action",
      "e.fingerprint",
      "e.detail",
      "e.reason",
      "e.source",
    ])
    .where("e.tableId", "=", tableId)
    .where("e.rowId", "=", rowId)
    .orderBy("e.at", "desc")
    .limit(200)
    .execute();
  const visible = (value: unknown) =>
    value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value as Record<string, unknown>).filter(
            ([name]) => !hidden(name),
          ),
        )
      : null;
  // A change found by a check shows what the lock before it sealed.
  const sealedBefore = new Map<number, Record<string, unknown>>();
  let sealed: Record<string, unknown> = {};
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.action === "lock") {
      sealed =
        (event.detail as { values?: Record<string, unknown> } | null)?.values ??
        {};
    }
    sealedBefore.set(index, sealed);
  }
  return events.map((event, index) => {
    const detail = storedDrift(event.detail);
    const changed = event.action === "changed" && detail;
    const fields = changed ? (detail.fields ?? []) : [];
    const before = sealedBefore.get(index) ?? {};
    return {
      occurredAt: event.at.toISOString(),
      userId: event.userId,
      displayName: event.displayName,
      action: event.action,
      oldValue: changed
        ? visible(
            Object.fromEntries(
              fields.map((name) => [name, before[name] ?? null]),
            ),
          )
        : null,
      newValue: changed ? visible(detail.values ?? {}) : null,
      reason: event.reason,
      source: event.source,
      state: null,
      fingerprint: event.fingerprint,
      missing: changed ? detail.missing === true : false,
    };
  });
}
