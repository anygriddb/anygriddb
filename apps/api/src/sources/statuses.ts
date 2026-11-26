/**
 * States and signatures on a client's rows (ADRs 0007, 0033, 0137).
 *
 * A client's table has no status column: the state of a row that left its
 * circuit's first state lives in AnyGridDB's database, named by the row's
 * key. The circuit is the table's own, as on AnyGridDB's rows (ADR 0124).
 * AnyGridDB refuses its own writes that a row's state forbids; other
 * applications are not refused, so a sealed state seals the row: its
 * stored values and their SHA-256 fingerprint are kept, and a job compares
 * the row with them to detect and tell a change made elsewhere.
 *
 * A step into a sealed state waits for the writes under way: a write
 * records its intent, then reads the row's state (`assertWritable`); the
 * step commits the state first, waits for every write recorded before, and
 * only then reads the row. Nothing holds a connection while a client's
 * transaction runs.
 */
import { createHash } from "node:crypto";
import {
  AppError,
  findAllowedTransition,
  initialState,
  isBlankCell,
  stateAllows,
  stateByKey,
  type StatusCircuit,
  type StatusState,
  type StatusTransition,
  type AuditRole,
  type EngineCatalog,
  isCopySourceEngine,
  numberToDecimal,
  type RowEvent,
  SEAL_FORMAT,
  sealDrift,
  sealedFields,
  type SealFormat,
  sealRow,
  sealText,
  shownSealValue,
  ceilingOf,
} from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { sql } from "kysely";
import { loadEngine, type TableRow } from "../data/engine.js";
import { liveBase, liveTable } from "../data/live.js";
import { readByIds, type RowRecord } from "../data/rows.js";
import { rowsWithin, type ReadBudget } from "../read-budget.js";
import { addJob, TASKS, type SqlExecutor } from "../queue/jobs.js";
import type { NotificationInput } from "../notifications.js";

/** A client row's status: a state of its table's circuit (ADR 0124). */
type ExternalStatus = string;

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
function fingerprintOf(
  values: Readonly<Record<string, unknown>>,
  format: SealFormat = SEAL_FORMAT,
) {
  return createHash("sha256")
    .update(`anygriddb-seal-${String(format)}\n${sealText(values)}`)
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

type StateRules = Pick<
  StatusState,
  "key" | "isInitial" | "rowWritable" | "writableFields" | "allowDelete"
>;

/**
 * The states of a table's circuit and what each lets AnyGridDB write, in
 * one read: what a page and a write need, without the circuit's steps.
 */
async function statesOf(db: Database, tableId: string): Promise<StateRules[]> {
  const states = await db
    .selectFrom("statusStates as s")
    .innerJoin("statusCircuits as c", "c.id", "s.circuitId")
    .select([
      "s.key",
      "s.isInitial",
      "s.rowWritable",
      "s.writableFields",
      "s.allowDelete",
    ])
    .where("c.tableId", "=", tableId)
    .execute();
  if (!states.some((state) => state.isInitial)) {
    throw new AppError("invalid_status");
  }
  return states;
}

/** The key of the first state, which a row with no entry is in. */
function firstOf(states: readonly StateRules[]): string {
  return states.find((state) => state.isInitial)?.key ?? "";
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
 * Refuses a write through AnyGridDB that the state of one of these rows
 * forbids: a change of a field it does not let change, or a delete
 * (ADR 0137). A write calls it before anything, and again once its intent
 * is recorded: a step into a sealed state that committed in between then
 * refuses it, and one that did not waits for it.
 */
export async function assertWritable(
  db: Database,
  tableId: string,
  rowIds: readonly string[],
  act: { delete: true } | { fields: readonly string[] },
): Promise<void> {
  const states = await statesOf(db, tableId);
  const refused = states
    .filter((state) => !stateAllows(state, act))
    .map((state) => state.key);
  if (refused.length === 0) return;
  // A row with no entry is in the first state.
  if (refused.includes(firstOf(states))) {
    const entered = new Set<string>();
    for (const chunk of chunks([...new Set(rowIds)], 500)) {
      const found = await db
        .selectFrom("externalStatuses")
        .select(["rowId", "status"])
        .where("tableId", "=", tableId)
        .where("rowId", "in", chunk)
        .execute();
      for (const row of found) {
        if (refused.includes(row.status)) throw new AppError("row_locked");
        entered.add(row.rowId);
      }
    }
    if (rowIds.some((id) => !entered.has(id))) {
      throw new AppError("row_locked");
    }
    return;
  }
  for (const chunk of chunks([...new Set(rowIds)], 500)) {
    const held = await db
      .selectFrom("externalStatuses")
      .select("rowId")
      .where("tableId", "=", tableId)
      .where("rowId", "in", chunk)
      .where("status", "in", refused)
      .executeTakeFirst();
    if (held) throw new AppError("row_locked");
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
  const first = firstOf(await statesOf(db, table.id));
  for (const row of rows) {
    const state = found.get(row.id);
    row.ag_status = state?.status ?? first;
    const drift = storedDrift(state?.drift);
    if (!state || !drift || !state.driftAt) continue;
    const sealed = (state.sealed ?? {}) as Record<string, unknown>;
    const fields = (drift.fields ?? []).filter((name) => !hidden(name));
    drifts.set(row.id, {
      at: state.driftAt.toISOString(),
      missing: drift.missing === true,
      fields,
      sealed: Object.fromEntries(
        fields.map((name) => [name, shownSealValue(sealed[name])]),
      ),
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
  sealFormat: number;
  /** Set while a step into a sealed state waits to seal the row. */
  fencedFrom: string | null;
};

async function readState(
  db: Database,
  tableId: string,
  rowId: string,
): Promise<State | undefined> {
  return db
    .selectFrom("externalStatuses")
    .select([
      "status",
      "version",
      "fingerprint",
      "sealed",
      "sealFormat",
      "fencedFrom",
    ])
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

/** A value of a store's copy as it read before whole numbers were kept. */
function roundedAsFirstRead(value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (/^-?\d{16,}$/.test(value)) {
    return numberToDecimal(Number(value)) ?? value;
  }
  if (!/^[[{]/.test(value)) return value;
  try {
    return JSON.stringify(
      JSON.parse(value, (_key, item: unknown) =>
        typeof item === "string" && /^-?\d{16,}$/.test(item)
          ? Number(item)
          : item,
      ),
    );
  } catch {
    return value;
  }
}

type Reading = Map<string, Record<string, unknown>>;

/**
 * Rows sealed in the first format, read the way that format read them
 * (ADR 0118): `first` is compared with the seal, and `renewal` gives the
 * values to seal again, or nothing while they cannot be trusted to stay
 * what a later check reads.
 */
type FirstFormat = {
  first: Reading;
  drift: (
    sealed: Readonly<Record<string, unknown>>,
    values: Readonly<Record<string, unknown>>,
  ) => string[];
  renewal: (
    rowId: string,
    sealed: Readonly<Record<string, unknown>>,
  ) => Record<string, unknown> | null;
};

async function readFirstFormat(
  db: Database,
  tableId: string,
  rowIds: readonly string[],
): Promise<FirstFormat> {
  const { engine: stored, rows: catalog } = await loadEngine(
    db,
    tableId,
    () => true,
  );
  const fields = sealedFields(stored.table).map((column) => column.name);
  const readAll = async (engine: EngineCatalog, format: SealFormat) => {
    const found: Reading = new Map();
    for (const chunk of chunks(rowIds)) {
      for (const row of await readByIds(db, engine, chunk, "UTC", fields)) {
        found.set(row.id, sealRow(engine.table, row, format));
      }
    }
    return found;
  };
  const sourceId = stored.table.external?.sourceId;
  // A store has only its copy, which a refresh rewrites whole numbers in.
  if (isCopySourceEngine(catalog.sources.get(sourceId ?? "")?.engine)) {
    const now = await readAll(stored, SEAL_FORMAT);
    return {
      first: await readAll(stored, 1),
      drift: (sealed, values) =>
        sealDrift(sealed, values).filter(
          (name) =>
            JSON.stringify(roundedAsFirstRead(values[name]) ?? null) !==
            JSON.stringify(sealed[name] ?? null),
        ),
      renewal: (rowId, sealed) =>
        /\d{16}/.test(sealText(sealed)) ? null : (now.get(rowId) ?? null),
    };
  }
  const live = stored.table.external?.synced
    ? (await loadEngine(db, tableId, () => true, { live: true })).engine
    : stored;
  // Read before and after: a change between the two readings is no seal's.
  const before = await readAll(live, SEAL_FORMAT);
  const first = await readAll({ ...live, firstSealReading: true }, 1);
  const after = await readAll(live, SEAL_FORMAT);
  // A copy that does not hold this reading yet would look changed.
  const copy = live === stored ? after : await readAll(stored, SEAL_FORMAT);
  return {
    first,
    drift: sealDrift,
    renewal: (rowId) => {
      const values = before.get(rowId);
      const same = (other: Reading) => {
        const held = other.get(rowId);
        return held && values && sealText(held) === sealText(values);
      };
      return values && same(after) && same(copy) ? values : null;
    },
  };
}

/**
 * Seals again in the current format the rows that still hold what their
 * first-format seal says, and says so in their trail. The signatures keep
 * the fingerprint they signed: the entry names it.
 */
async function renewSeals(
  db: Database,
  tableId: string,
  rows: ReadonlyArray<{
    rowId: string;
    version: number;
    fingerprint: string | null;
    sealed: Record<string, unknown> | null;
  }>,
  reading: FirstFormat,
): Promise<void> {
  const renewed = rows.flatMap((row) => {
    const first = reading.first.get(row.rowId);
    if (!first || !row.sealed || !row.fingerprint) return [];
    if (reading.drift(row.sealed, first).length > 0) return [];
    const values = reading.renewal(row.rowId, row.sealed);
    return values ? [{ row, values, fingerprint: fingerprintOf(values) }] : [];
  });
  if (renewed.length === 0) return;
  await db.transaction().execute(async (tx) => {
    for (const { row, values, fingerprint } of renewed) {
      const done = await tx
        .updateTable("externalStatuses")
        .set({ sealed: values, fingerprint, sealFormat: SEAL_FORMAT })
        .where("tableId", "=", tableId)
        .where("rowId", "=", row.rowId)
        .where("version", "=", row.version)
        .where("sealFormat", "=", 1)
        .where("fingerprint", "=", row.fingerprint)
        .executeTakeFirst();
      if (done.numUpdatedRows === 0n) continue;
      await logEvent(
        tx,
        {
          userId: null,
          table: { id: tableId },
          rowId: row.rowId,
          source: "check",
        },
        "resealed",
        fingerprint,
        { from: 1, to: SEAL_FORMAT, previous: row.fingerprint, values },
      );
    }
  });
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

/** A step's input: who takes which step of the circuit on which row. */
type StepInput = StatusInput & {
  role: AuditRole;
  transitionKey: string;
  reason?: string;
  meaning?: string;
};

type Moved = { from: string; to: string; transitionKey: string };

/** The table's circuit, read where the native rows read it. */
async function circuitOf(
  db: Database,
  tableId: string,
): Promise<StatusCircuit> {
  const { loadTableCircuit } = await import("../data/status-circuits.js");
  return loadTableCircuit(db, tableId);
}

/** What the trail names a step: the four of compliance, any other a step. */
function actionOf(key: string): EventAction {
  return key === "submit" ||
    key === "lock" ||
    key === "unlock" ||
    key === "sign"
    ? key
    : "transition";
}

/**
 * Takes a step of its table's circuit on a client's row (ADRs 0124, 0137).
 * The row's state lives beside it, and no entry is the circuit's first
 * state. A step into a sealed state seals what the row holds then: its
 * values and their fingerprint, which a check compares with the database
 * afterwards. A step from a sealed state to another, as a signature, holds
 * only while the row still holds what was sealed.
 */
export async function transitionExternalRow(
  db: Database,
  input: StepInput,
): Promise<Moved> {
  assertKeyed(input.table);
  const { table, rowId } = input;
  const circuit = await circuitOf(db, table.id);
  let state = await readState(db, table.id, rowId);
  // A step that is still sealing the row owns it until it ends: another
  // taken meanwhile would leave its fence behind, and the row would go
  // back where the first step started.
  if (state?.fencedFrom) throw new AppError("source_row_busy");
  const from = state?.status ?? initialState(circuit).key;
  const step = findAllowedTransition(
    circuit,
    from,
    input.transitionKey,
    input.role,
  );
  const leaving = stateByKey(circuit, from);
  const entering = stateByKey(circuit, step.toStateKey);
  if (!leaving || !entering) throw new AppError("invalid_status");
  if (step.requireReason && !input.reason?.trim()) {
    throw new AppError("reason_required");
  }
  if (step.signature !== "none" && !input.meaning?.trim()) {
    throw new AppError("meaning_required");
  }
  if (step.fourEyes) await assertOtherHand(db, input);
  const moved = { from, to: entering.key, transitionKey: step.key };
  const sealedBefore = leaving.seal && state?.fingerprint ? state : undefined;
  if (entering.seal && !sealedBefore) {
    await sealInto(db, input, state, step, moved);
    return moved;
  }
  if (!entering.isInitial || step.requireFields.length > 0) {
    await assertRowHolds(db, input, step.requireFields);
  }
  if (sealedBefore && entering.seal) {
    state = await sealStillHolds(db, input, sealedBefore);
  }
  const fingerprint = sealedBefore ? (state?.fingerprint ?? null) : null;
  await db.transaction().execute(async (tx) => {
    const done = await moveEntry(tx, input, state, entering);
    if (!done) throw new AppError("invalid_status");
    if (step.signature !== "none") {
      await signedBy(tx, input, fingerprint);
    }
    await logEvent(
      tx,
      input,
      actionOf(step.key),
      fingerprint,
      { from, to: entering.key, step: step.key },
      input.reason,
    );
    await queueStatusEvent(tx, input);
  });
  return moved;
}

/** The row is there, and its fields a step asks for are filled. */
async function assertRowHolds(
  db: Database,
  input: StepInput,
  fields: readonly string[],
): Promise<void> {
  const { engine } = await loadEngine(db, input.table.id, () => true);
  const [row] = await readByIds(db, engine, [input.rowId], "UTC", fields);
  if (!row) throw new AppError("source_row_missing");
  const blank = fields.find((field) => isBlankCell(row[field]));
  if (blank !== undefined) {
    const label =
      engine.table.columns.find((column) => column.name === blank)?.label ??
      blank;
    throw new AppError("value_required", label);
  }
}

/** A step that asks two people refuses the one who took the step before. */
async function assertOtherHand(db: Database, input: StepInput): Promise<void> {
  const last = await db
    .selectFrom("externalStatusEvents")
    .select("userId")
    .where("tableId", "=", input.table.id)
    .where("rowId", "=", input.rowId)
    .where("userId", "is not", null)
    .where("action", "not in", ["changed", "restored", "resealed"])
    .orderBy("at", "desc")
    .orderBy("id", "desc")
    .executeTakeFirst();
  if (last?.userId === input.userId) throw new AppError("four_eyes");
}

/**
 * Moves a row's entry to a state that seals nothing, or keeps the seal
 * of a step between two sealed states: the first state is no entry.
 * False when the row moved meanwhile.
 */
async function moveEntry(
  tx: SqlExecutor,
  input: StepInput,
  state: State | undefined,
  entering: StatusState,
): Promise<boolean> {
  const { table, rowId } = input;
  if (entering.isInitial && !entering.seal) {
    if (!state) return true;
    const removed = await sql`
      delete from external_statuses
       where table_id = ${table.id} and row_id = ${rowId}
         and version = ${state.version}
    `.execute(tx);
    return removed.numAffectedRows === 1n;
  }
  if (!state) {
    const added = await sql<{ rowId: string }>`
      insert into external_statuses (table_id, row_id, status, updated_by)
      values (${table.id}, ${rowId}, ${entering.key}, ${input.userId})
      on conflict do nothing
      returning row_id
    `.execute(tx);
    return added.rows.length === 1;
  }
  // Leaving a seal for a state that has none takes the seal away.
  const unseal = entering.seal
    ? sql``
    : sql`, sealed = null, fingerprint = null, sealed_at = null,
          drift = null, drift_at = null, checked_at = null`;
  const moved = await sql`
    update external_statuses
       set status = ${entering.key}, version = version + 1,
           updated_by = ${input.userId}, updated_at = now() ${unseal}
     where table_id = ${table.id} and row_id = ${rowId}
       and version = ${state.version}
  `.execute(tx);
  return moved.numAffectedRows === 1n;
}

/** The signature a step asks, naming the seal it signs when there is one. */
async function signedBy(
  tx: SqlExecutor,
  input: StepInput,
  fingerprint: string | null,
): Promise<void> {
  const named = await sql<{ displayName: string }>`
    select display_name from users where id = ${input.userId}
  `.execute(tx);
  const displayName = named.rows[0]?.displayName;
  if (!displayName) throw new AppError("no_row");
  await sql`
    insert into row_signatures
      (user_id, table_id, record_id, display_name, meaning, fingerprint)
    values (
      ${input.userId}, ${input.table.id}, ${input.rowId}, ${displayName},
      ${(input.meaning ?? "").trim()}, ${fingerprint}
    )
  `.execute(tx);
}

/**
 * Takes a sealed state in two steps: the state first, so writes from now on
 * are refused, and the state it left kept beside it; then, once the writes
 * recorded before have finished, the seal of what the row holds.
 */
async function sealInto(
  db: Database,
  input: StepInput,
  state: State | undefined,
  step: StatusTransition,
  moved: Moved,
): Promise<void> {
  const { table, rowId } = input;
  const fenced = (state?.version ?? -1) + 1;
  const fence = state
    ? await sql`
        update external_statuses
           set status = ${moved.to}, sealed = null, fingerprint = null,
               sealed_at = null, drift = null, drift_at = null,
               fenced_from = ${moved.from}, version = ${fenced},
               updated_by = ${input.userId}, updated_at = now()
         where table_id = ${table.id} and row_id = ${rowId}
           and version = ${state.version}
      `.execute(db)
    : await sql`
        insert into external_statuses
          (table_id, row_id, status, fenced_from, version, updated_by)
        values (
          ${table.id}, ${rowId}, ${moved.to}, ${moved.from}, ${fenced},
          ${input.userId}
        )
        on conflict do nothing
      `.execute(db);
  if (fence.numAffectedRows !== 1n) throw new AppError("invalid_status");
  let sealed: Record<string, unknown> | null;
  try {
    if (step.requireFields.length > 0) {
      await assertRowHolds(db, input, step.requireFields);
    }
    await drainWrites(db, table.id, rowId);
    sealed = await readSealed(db, table.id, rowId);
    if (!sealed) throw new AppError("source_row_missing");
  } catch (error) {
    // Back where it was: the row could not be read, so nothing is sealed.
    await (
      state
        ? sql`
          update external_statuses
             set status = ${moved.from}, fenced_from = null,
                 version = ${fenced + 1}
           where table_id = ${table.id} and row_id = ${rowId}
             and version = ${fenced}
        `
        : sql`
          delete from external_statuses
           where table_id = ${table.id} and row_id = ${rowId}
             and version = ${fenced}
        `
    ).execute(db);
    throw error;
  }
  const fingerprint = fingerprintOf(sealed);
  await db.transaction().execute(async (tx) => {
    const done = await tx
      .updateTable("externalStatuses")
      .set({
        sealed,
        fingerprint,
        sealFormat: SEAL_FORMAT,
        sealedAt: new Date(),
        checkedAt: new Date(),
        fencedFrom: null,
      })
      .where("tableId", "=", table.id)
      .where("rowId", "=", rowId)
      .where("version", "=", fenced)
      .where("status", "=", moved.to)
      .executeTakeFirst();
    // Moved again while it waited.
    if (done.numUpdatedRows === 0n) throw new AppError("invalid_status");
    if (step.signature !== "none") await signedBy(tx, input, fingerprint);
    await logEvent(
      tx,
      input,
      actionOf(step.key),
      fingerprint,
      { from: moved.from, to: moved.to, step: step.key, values: sealed },
      input.reason,
    );
    await queueStatusEvent(tx, input);
  });
}

/**
 * A step between two sealed states holds only while the row read again
 * still holds what was sealed: a row that moved is checked, recorded and
 * told, and the step refused. A seal of the first format is compared as it
 * read, then sealed anew (ADR 0118).
 */
async function sealStillHolds(
  db: Database,
  input: StepInput,
  read: State,
): Promise<State> {
  const { table, rowId } = input;
  let holds: boolean;
  let state = read;
  if (read.sealFormat === SEAL_FORMAT) {
    const current = await readSealed(db, table.id, rowId);
    holds =
      current !== null && sealDrift(read.sealed ?? {}, current).length === 0;
  } else {
    const reading = await readFirstFormat(db, table.id, [rowId]);
    const first = reading.first.get(rowId);
    holds =
      first !== undefined &&
      reading.drift(read.sealed ?? {}, first).length === 0;
    if (holds) {
      await renewSeals(db, table.id, [{ ...read, rowId }], reading);
      const renewed = await readState(db, table.id, rowId);
      if (renewed?.status !== read.status || !renewed.fingerprint) {
        throw new AppError("invalid_status");
      }
      state = renewed;
    }
  }
  if (!holds) {
    await queueSealCheck(db, table.id, [rowId]);
    throw new AppError("row_changed_elsewhere");
  }
  return state;
}

type EventAction =
  | "submit"
  | "lock"
  | "unlock"
  | "sign"
  | "transition"
  | "changed"
  | "restored"
  | "resealed";

async function logEvent(
  executor: SqlExecutor,
  input: { userId: string | null; table: { id: string }; rowId: string } & {
    source: string;
  },
  action: EventAction,
  fingerprint: string | null,
  detail: unknown,
  reason?: string,
): Promise<void> {
  await sql`
    insert into external_status_events
      (user_id, table_id, row_id, action, fingerprint, detail, reason, source)
    values (
      ${input.userId}, ${input.table.id}, ${input.rowId}, ${action},
      ${fingerprint}, ${detail === null ? null : JSON.stringify(detail)}::jsonb,
      ${reason?.trim() || null}, ${input.source.slice(0, 100)}
    )
  `.execute(executor);
}

/**
 * A row AnyGridDB deleted takes its state with it, as on its own tables:
 * the delete was asked of its state first (`assertWritable`).
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
      .execute();
  }
}

/** Queues a check of these rows, when some of them are sealed. */
async function queueSealCheck(
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
      .where("fingerprint", "is not", null)
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
  fingerprint: string | null;
  sealFormat: number;
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
  if (!only) await revertStaleSeals(deps.db);
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
      "s.fingerprint",
      "s.sealFormat",
    ])
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
    const sealedNow = rows.filter((row) => row.sealFormat === SEAL_FORMAT);
    const sealedBefore = rows.filter((row) => row.sealFormat !== SEAL_FORMAT);
    let current: Map<string, Record<string, unknown>>;
    let firstFormat: FirstFormat | undefined;
    try {
      const { engine } = await loadEngine(deps.db, tableId, () => true);
      const fields = sealedFields(engine.table).map((column) => column.name);
      current = new Map();
      for (const chunk of chunks(sealedNow.map((row) => row.rowId))) {
        const read = await readByIds(deps.db, engine, chunk, "UTC", fields);
        for (const row of read) current.set(row.id, sealRow(engine.table, row));
      }
      if (sealedBefore.length > 0) {
        firstFormat = await readFirstFormat(
          deps.db,
          tableId,
          sealedBefore.map((row) => row.rowId),
        );
      }
    } catch (error) {
      if (!(error instanceof AppError && error.code === "unknown_table")) {
        deps.log(error, "seal check failed");
      }
      // Its turn passes: a source that does not answer holds no one up.
      await markChecked(deps.db, tableId, rows);
      continue;
    }
    const moved = await recordFindings(deps, tableId, sealedNow, current);
    if (firstFormat) {
      moved.push(
        ...(await recordFindings(
          deps,
          tableId,
          sealedBefore,
          firstFormat.first,
          firstFormat.drift,
        )),
      );
      await renewSeals(deps.db, tableId, sealedBefore, firstFormat);
    }
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
const FENCE_TIMEOUT_MS = ceilingOf("timeout.client_status_fence_ms");

/**
 * A step into a sealed state whose process stopped between taking the state
 * and sealing the row seals nothing: the row goes back to the state it
 * left, for the step to be taken again.
 */
async function revertStaleSeals(db: Database): Promise<void> {
  await sql`
    update external_statuses
       set status = fenced_from, fenced_from = null, version = version + 1
     where fenced_from is not null and fingerprint is null
       and updated_at < ${new Date(Date.now() - FENCE_TIMEOUT_MS)}
  `.execute(db);
}

/** Records what one check found; returns the rows whose mark moved. */
async function recordFindings(
  deps: SealDeps,
  tableId: string,
  rows: readonly Sealed[],
  current: ReadonlyMap<string, Record<string, unknown>>,
  driftOf: FirstFormat["drift"] = sealDrift,
): Promise<string[]> {
  if (rows.length === 0) return [];
  const now = new Date();
  const moved: Array<{ row: Sealed; drift: StoredDrift | null }> = [];
  for (const row of rows) {
    const values = current.get(row.rowId);
    const fields = values ? driftOf(row.sealed ?? {}, values) : [];
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
  budget?: ReadBudget,
) {
  const trail = db
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
    .limit(200);
  const events = await rowsWithin(trail, budget);
  const visible = (value: unknown) =>
    value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value as Record<string, unknown>)
            .filter(([name]) => !hidden(name))
            .map(([name, held]) => [name, shownSealValue(held)]),
        )
      : null;
  // A change found by a check shows what the lock before it sealed.
  const sealedBefore = new Map<number, Record<string, unknown>>();
  let sealed: Record<string, unknown> = {};
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    // What a step sealed, or a renewal sealed anew; a change found holds
    // values too, which seal nothing.
    const values = (
      event?.detail as { values?: Record<string, unknown> } | null
    )?.values;
    if (event && event.action !== "changed" && values) sealed = values;
    sealedBefore.set(index, sealed);
  }
  return events.map((event, index) => {
    const detail = storedDrift(event.detail);
    const changed = event.action === "changed" && detail;
    const fields = changed ? (detail.fields ?? []) : [];
    const before = sealedBefore.get(index) ?? {};
    return {
      id: null as string | null,
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
