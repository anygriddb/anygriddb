/**
 * Writes to a client's tables (ADRs 0006, 0007). An administrator enables
 * them per table: editing, adding, and deleting apart.
 *
 * A change is compared, not imposed: the rows are locked in the client's
 * database, read again, and each value the person changes must still be
 * the one they saw. Otherwise nothing is written and they are told.
 *
 * No transaction spans AnyGridDB's database and the client's, so every
 * write is recorded in three steps: its intent, committed before the
 * client's transaction commits; `applied` once it committed; `confirmed`
 * once the row read again shows it. A job settles what a crash left open
 * by reading the row again.
 */
import { randomUUID } from "node:crypto";
import {
  AppError,
  assertCellValue,
  buildExternalDelete,
  buildExternalInsert,
  buildExternalLock,
  buildExternalUpdate,
  buildInsertedId,
  buildReadRows,
  buildSideDelete,
  buildSideEnsure,
  buildSideLock,
  buildSideUpsert,
  type CellValue,
  type EngineCatalog,
  type ExternalValue,
  MAX_READ_LIMIT,
  type RowEvent,
  sameCell,
  type StoredColumn,
} from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { sql } from "kysely";
import type { CatalogRows, TableRow } from "../data/engine.js";
import {
  addJob,
  queueSummaryEvent,
  type SummaryEvent,
  TASKS,
} from "../queue/jobs.js";
import { readByIds } from "../data/rows.js";
import {
  enrichmentRow,
  loadEnrichmentValues,
  lockEnrichmentValues,
  upsertEnrichmentValues,
} from "./enrichment-values.js";
import { loadEngine } from "../data/engine.js";
import {
  sourcePools,
  wasRolledBack,
  type Run,
  type WriteBody,
} from "./pools.js";
import { assertUnsealed, forgetStatuses } from "./statuses.js";

export type ExternalWriteContext = {
  userId: string;
  table: TableRow;
  /** The table as the writer reads it: their field and row rules apply. */
  engine: EngineCatalog;
  catalog: CatalogRows;
  reason: string | null;
  source: string;
  depth: number;
  /**
   * One event for the whole operation, such as an import, instead of one
   * per row: each batch brings its count up to date.
   */
  summary?: SummaryEvent;
};

export type ExternalUpdate = {
  rowId: string;
  values: Readonly<Record<string, CellValue>>;
  /** What the person saw in each field they change; compared under lock. */
  expected?: Readonly<Record<string, CellValue>> | undefined;
};

type Action = "insert" | "update" | "delete";

/** Rows locked and read at a time. */
const CHUNK = 100;

function chunks<T>(items: readonly T[]): T[][] {
  const list: T[][] = [];
  for (let start = 0; start < items.length; start += CHUNK) {
    list.push(items.slice(start, start + CHUNK));
  }
  return list;
}

/** A synced table is a copy (ADR 0034): it is changed in its source. */
function assertLive(context: ExternalWriteContext): void {
  if (context.engine.table.external?.synced) {
    throw new AppError("external_table_synced");
  }
}

/** Refuses what the administrator did not enable on this table. */
function assertEnabled(context: ExternalWriteContext, action: Action): string {
  const { table } = context;
  if (table.storage !== "external" || !table.sourceId) {
    throw new AppError("internal_error", "native table");
  }
  assertLive(context);
  if ((table.externalKey ?? []).length === 0) {
    throw new AppError("external_table_no_key");
  }
  const enabled =
    action === "update"
      ? table.externalUpdate
      : action === "insert"
        ? table.externalInsert
        : table.externalDelete;
  if (!enabled) {
    throw new AppError(
      action === "update"
        ? "external_table_read_only"
        : action === "insert"
          ? "external_insert_off"
          : "external_delete_off",
    );
  }
  return table.sourceId;
}

/**
 * A write of AnyGridDB's own fields only (ADR 0032): the client's table is
 * not changed, so its switches do not apply; a row still needs a key.
 */
function assertSideWrite(context: ExternalWriteContext): string {
  const { table } = context;
  if (table.storage !== "external" || !table.sourceId) {
    throw new AppError("internal_error", "native table");
  }
  assertLive(context);
  if ((table.externalKey ?? []).length === 0) {
    throw new AppError("external_table_no_key");
  }
  return table.sourceId;
}

/** A row's values for the client's table, and for the side table. */
function splitSide(values: readonly ExternalValue[]): {
  own: ExternalValue[];
  side: ExternalValue[];
  controlPlane: ExternalValue[];
} {
  return {
    own: values.filter(
      (item) =>
        !item.column.physical.side && !item.column.physical.controlPlane,
    ),
    side: values.filter((item) => item.column.physical.side === true),
    controlPlane: values.filter(
      (item) => item.column.physical.controlPlane === true,
    ),
  };
}

/**
 * The client columns behind `names`, each one AnyGridDB writes back
 * exactly, and for a change one the account may update. A link writes the
 * client's own foreign key.
 */
function storedColumns(
  context: ExternalWriteContext,
  names: Iterable<string>,
  action: "insert" | "update",
): Map<string, StoredColumn> {
  const found = new Map<string, StoredColumn>();
  for (const name of names) {
    const column = context.engine.table.columns.find(
      (item) => item.name === name,
    );
    if (!column) throw new AppError("unknown_column", name);
    const row = context.catalog.columns.find((item) => item.id === column.id);
    const forward =
      column.relation?.kind === "one_to_many" &&
      column.relation.direction === "forward";
    const allowed =
      action === "insert" ? row?.externalInsertable : row?.externalWritable;
    if (!column.physical || !allowed) {
      throw new AppError("column_is_read_only", column.label);
    }
    if (column.relation && !forward) {
      throw new AppError("column_is_read_only", column.label);
    }
    found.set(name, { ...column, physical: column.physical });
  }
  return found;
}

function externalValues(
  columns: ReadonlyMap<string, StoredColumn>,
  values: Readonly<Record<string, CellValue>>,
): ExternalValue[] {
  return Object.entries(values).map(([name, value]) => {
    const column = columns.get(name);
    if (!column) throw new AppError("unknown_column", name);
    if (!column.relation) {
      assertCellValue(column, value);
      return { column, value };
    }
    return { column, value: oneLink(value) };
  });
}

/**
 * The target a client's foreign key holds: one id, as a link cell or a
 * list of ids gives it (a new row, a duplicate, a paste), or none.
 */
function oneLink(value: CellValue): CellValue {
  if (!Array.isArray(value)) return value;
  if (value.length > 1) throw new AppError("invalid_relation");
  const [first] = value as unknown[];
  if (first === undefined) return null;
  if (typeof first === "string") return first;
  if (first && typeof first === "object" && "id" in first) {
    return String(first.id);
  }
  throw new AppError("invalid_relation");
}

/** The fields of rows read under lock, by id. */
async function readRows(
  context: ExternalWriteContext,
  run: Run,
  ids: readonly string[],
  fields: readonly string[],
): Promise<Map<string, Record<string, unknown>>> {
  const found = new Map<string, Record<string, unknown>>();
  for (const chunk of chunks(ids)) {
    const rows = await run(
      buildReadRows(context.engine, {
        rowIds: chunk,
        fields,
        limit: Math.min(chunk.length, MAX_READ_LIMIT),
        timeZone: "UTC",
      }),
    );
    for (const row of rows) found.set(String(row.id), row);
  }
  return found;
}

function pick(
  row: Record<string, unknown> | undefined,
  names: readonly string[],
): Record<string, unknown> | null {
  if (!row) return null;
  return Object.fromEntries(names.map((name) => [name, row[name] ?? null]));
}

/** A link's value is the target's key; anything else is the cell. */
function linkKey(value: unknown): unknown {
  if (Array.isArray(value)) {
    const [first] = value as Array<{ id?: unknown }>;
    return first?.id ?? null;
  }
  return value;
}

function labelOf(context: ExternalWriteContext, name: string): string {
  return (
    context.engine.table.columns.find((column) => column.name === name)
      ?.label ?? name
  );
}

/**
 * A client's error names its own column: tell the person the field's
 * label instead.
 */
function withLabel(context: ExternalWriteContext, error: unknown): unknown {
  if (!(error instanceof AppError) || !error.detail) return error;
  const column = context.engine.table.columns.find(
    (item) => item.physical?.name === error.detail,
  );
  if (!column || column.label === error.detail) return error;
  return new AppError(error.code, column.label, { cause: error });
}

type Intent = {
  id: string;
  rowId: string | null;
  action: Action;
  oldValue: Record<string, unknown> | null;
  newValue: Record<string, unknown> | null;
  /** The delete this insert puts back, from the row trash. */
  restores?: string;
};

/** Step one: the intent, committed before the client's transaction is. */
async function recordIntents(
  db: Database,
  context: ExternalWriteContext,
  sourceId: string,
  intents: readonly Intent[],
): Promise<void> {
  for (const chunk of chunks(intents)) {
    await db
      .insertInto("externalWrites")
      .values(
        chunk.map((intent) => ({
          id: intent.id,
          userId: context.userId,
          tableId: context.table.id,
          sourceId,
          rowId: intent.rowId,
          action: intent.action,
          oldValue: intent.oldValue,
          newValue: intent.newValue,
          reason: context.reason,
          source: context.source,
          restores: intent.restores ?? null,
        })),
      )
      .execute();
  }
}

type Step = "applied" | "confirmed" | "abandoned" | "unverified";

/** Records steps; a step already recorded stays as it was. */
async function recordSteps(
  db: Pick<Database, "insertInto">,
  steps: ReadonlyArray<{ writeId: string; step: Step; detail: unknown }>,
): Promise<void> {
  for (const chunk of chunks(steps)) {
    await db
      .insertInto("externalWriteSteps")
      .values(
        chunk.map((item) => ({
          writeId: item.writeId,
          step: item.step,
          detail: item.detail ?? null,
        })),
      )
      .onConflict((conflict) => conflict.doNothing())
      .execute();
  }
}

/** When the job reads applied rows again: soon after the write. */
const CONFIRM_AFTER_MS = 2_000;

/**
 * Step two, once the client's transaction committed: `applied` with the
 * row as the write's transaction read it back, the row events webhooks and
 * automations wait for, and the job that confirms it. One transaction:
 * the events go out if and only if the write is recorded as applied.
 */
async function recordApplied(
  db: Database,
  context: ExternalWriteContext,
  applied: ReadonlyArray<{
    intent: Intent;
    rowId: string;
    row: Record<string, unknown> | null;
    columns?: readonly string[];
  }>,
): Promise<void> {
  if (applied.length === 0) return;
  const at = new Date().toISOString();
  await db.transaction().execute(async (tx) => {
    await recordSteps(
      tx,
      applied.map((item) => ({
        writeId: item.intent.id,
        step: "applied" as const,
        detail: { rowId: item.rowId, row: item.row },
      })),
    );
    if (context.summary) {
      await queueSummaryEvent(tx, context.summary);
    }
    for (const item of context.summary ? [] : applied) {
      const event: RowEvent = {
        tableId: context.table.id,
        event: item.intent.action,
        rowId: item.rowId,
        ...(item.columns ? { columns: item.columns.slice(0, 500) } : {}),
        actorId: context.userId,
        source: context.source.slice(0, 100),
        ...(context.depth > 0 ? { depth: context.depth } : {}),
        at,
      };
      await addJob(tx, TASKS.rowEvents, { event }, { maxAttempts: 10 });
    }
    await addJob(
      tx,
      TASKS.externalSettle,
      {},
      {
        runAt: new Date(Date.now() + CONFIRM_AFTER_MS),
        jobKey: "external_settle",
        jobKeyMode: "preserve_run_at",
        maxAttempts: 1,
      },
    );
  });
}

/**
 * Runs a write in the client's database, and settles its intents when it
 * failed: `abandoned` when the client rolled it back. A failure while it
 * committed leaves them open: only reading the rows again can tell.
 */
async function written<T>(
  db: Database,
  context: ExternalWriteContext,
  sourceId: string,
  intents: Intent[],
  body: WriteBody<T>,
): Promise<T> {
  try {
    return await sourcePools().write(sourceId, body);
  } catch (error) {
    if (wasRolledBack(error) && intents.length > 0) {
      // Recorded intents only; when this fails too, the job settles them.
      await recordSteps(
        db,
        intents.map((intent) => ({
          writeId: intent.id,
          step: "abandoned" as const,
          detail: {
            error: error instanceof AppError ? error.code : "internal_error",
          },
        })),
      ).catch(() => undefined);
    }
    throw withLabel(context, error);
  }
}

/** Changes cells of rows, each compared with what the person saw. */
export async function updateExternalRows(
  db: Database,
  context: ExternalWriteContext,
  updates: readonly ExternalUpdate[],
): Promise<string[]> {
  // One change per row: several for the same row merge, in order.
  const merged = new Map<string, ExternalUpdate>();
  for (const update of updates) {
    if (Object.keys(update.values).length === 0) continue;
    const before = merged.get(update.rowId);
    merged.set(update.rowId, {
      rowId: update.rowId,
      values: { ...before?.values, ...update.values },
      expected: { ...update.expected, ...before?.expected },
    });
  }
  const work = [...merged.values()];
  if (work.length === 0) return [];
  const ids = work.map((update) => update.rowId);
  const fields = [
    ...new Set(work.flatMap((update) => Object.keys(update.values))),
  ];
  // Only AnyGridDB's own fields: the client's table is not written, its
  // side rows are locked instead. Otherwise the table's switch comes
  // first: it is what an administrator can change.
  const enrichmentOnly = fields.every((name) => {
    const physical = context.engine.table.columns.find(
      (column) => column.name === name,
    )?.physical;
    return physical?.controlPlane === true;
  });
  const sideOnly = fields.every((name) => {
    const physical = context.engine.table.columns.find(
      (column) => column.name === name,
    )?.physical;
    return physical?.side === true || physical?.controlPlane === true;
  });
  const sourceId = sideOnly
    ? assertSideWrite(context)
    : assertEnabled(context, "update");
  const columns = storedColumns(context, fields, "update");
  const table = context.engine.table;
  // A locked or signed row is refused before anything (ADR 0033).
  await assertUnsealed(db, context.table.id, ids);

  const patches = work.map((update) => {
    const { own, side, controlPlane } = splitSide(
      externalValues(columns, update.values),
    );
    return { update, own, side, controlPlane };
  });
  // Fields kept in AnyGridDB's database (ADR 0046) are compared and written
  // under a lock of their rows there, held across the client's write.
  const keptIds = patches
    .filter((patch) => patch.controlPlane.length > 0)
    .map((patch) => patch.update.rowId);
  const keptNames = new Set(
    patches.flatMap((patch) =>
      patch.controlPlane.map((item) => item.column.name),
    ),
  );

  if (enrichmentOnly) {
    // The client's rows must exist; their own table is not touched.
    const present = new Set(
      (await readByIds(db, context.engine, ids, "UTC", [])).map(
        (row) => row.id,
      ),
    );
    if (ids.some((id) => !present.has(id))) {
      throw new AppError("source_row_missing");
    }
  }
  const statements = patches.map(({ update, own, side }) => ({
    update,
    sql: [
      ...(own.length > 0
        ? [buildExternalUpdate(table, update.rowId, own)]
        : []),
      ...(side.length > 0 ? [buildSideUpsert(table, update.rowId, side)] : []),
    ],
  }));
  const intents: Intent[] = [];
  const stored = await db.transaction().execute(async (tx) => {
    const kept = await lockEnrichmentValues(tx, context.table.id, keptIds);
    const keptRow = (rowId: string) =>
      enrichmentRow(kept.get(rowId), table.columns, keptNames);
    // Compares what the person saw, records the intents, then fences
    // against a lock that committed meanwhile (ADR 0033).
    const plan = async (
      current: ReadonlyMap<string, Record<string, unknown>>,
    ) => {
      for (const { update } of statements) {
        const row = { ...current.get(update.rowId), ...keptRow(update.rowId) };
        for (const [name, value] of Object.entries(update.expected ?? {})) {
          if (!(name in update.values)) continue;
          const seen = columns.get(name)?.relation
            ? linkKey(row[name])
            : row[name];
          if (
            !sameCell(
              seen,
              columns.get(name)?.relation ? linkKey(value) : value,
            )
          ) {
            throw new AppError("source_conflict", labelOf(context, name));
          }
        }
      }
      const planned = statements.map(({ update }): Intent => ({
        id: randomUUID(),
        rowId: update.rowId,
        action: "update",
        oldValue: pick(
          { ...current.get(update.rowId), ...keptRow(update.rowId) },
          Object.keys(update.values),
        ),
        newValue: { ...update.values },
      }));
      await recordIntents(db, context, sourceId, planned);
      intents.push(...planned);
      // Again once the intents are recorded: a lock that committed since
      // refuses the write, and one that did not waits for it.
      await assertUnsealed(db, context.table.id, ids);
    };
    const read: ReadonlyMap<string, Record<string, unknown>> = enrichmentOnly
      ? await (async () => {
          await plan(new Map());
          return new Map();
        })()
      : await written(db, context, sourceId, intents, async (run, change) => {
          for (const chunk of chunks(ids)) {
            if (sideOnly) {
              const ensure = buildSideEnsure(table, chunk);
              if (ensure) await change(ensure);
              await run(buildSideLock(table, chunk));
            } else {
              await run(buildExternalLock(table, chunk));
            }
          }
          const current = await readRows(context, run, ids, fields);
          for (const { update } of statements) {
            if (!current.get(update.rowId)) {
              throw new AppError("source_row_missing");
            }
          }
          await plan(current);
          for (const { sql } of statements) {
            for (const statement of sql) await change(statement);
          }
          return readRows(context, run, ids, fields);
        });
    // The client's part committed: AnyGridDB's own values follow it.
    for (const { update, controlPlane } of patches) {
      if (controlPlane.length === 0) continue;
      await upsertEnrichmentValues(tx, {
        tableId: context.table.id,
        rowId: update.rowId,
        userId: context.userId,
        patch: Object.fromEntries(
          controlPlane.map((item) => [item.column.id, item.value]),
        ),
      });
    }
    return read;
  });
  const keptAfter = await loadEnrichmentValues(db, context.table.id, keptIds);
  await recordApplied(
    db,
    context,
    intents.map((intent) => {
      const rowId = intent.rowId ?? "";
      return {
        intent,
        rowId,
        row: pick(
          {
            ...stored.get(rowId),
            ...enrichmentRow(keptAfter.get(rowId), table.columns, keptNames),
          },
          Object.keys(intent.newValue ?? {}),
        ),
        columns: Object.keys(intent.newValue ?? {}),
      };
    }),
  );
  return ids;
}

/** Adds rows; returns their ids, as the client's keys name them. */
export async function insertExternalRows(
  db: Database,
  context: ExternalWriteContext,
  rows: ReadonlyArray<Readonly<Record<string, CellValue>>>,
  /** Per row, the delete it puts back from the trash. */
  restores?: readonly string[],
): Promise<string[]> {
  const sourceId = assertEnabled(context, "insert");
  if (rows.length === 0) return [];
  const fields = [...new Set(rows.flatMap((values) => Object.keys(values)))];
  const columns = storedColumns(context, fields, "insert");
  const table = context.engine.table;
  const mysqlLike =
    table.external?.dialect === "mysql" ||
    table.external?.dialect === "mariadb";
  const statements = rows.map((values) => {
    // AnyGridDB's own fields go in the side row, once the key is known.
    const { own, side, controlPlane } = splitSide(
      externalValues(columns, values),
    );
    // MySQL and MariaDB name the new row apart: by its key or AUTO_INCREMENT.
    const inserted = mysqlLike ? buildInsertedId(table, own) : null;
    if (mysqlLike && !inserted) throw new AppError("source_row_key_unknown");
    return {
      values,
      sql: buildExternalInsert(table, own),
      inserted,
      side,
      controlPlane,
    };
  });
  const planned: Intent[] = statements.map((statement, index) => ({
    id: randomUUID(),
    rowId: null,
    action: "insert",
    oldValue: null,
    newValue: { ...statement.values },
    ...(restores?.[index] ? { restores: restores[index] } : {}),
  }));
  const intents: Intent[] = [];
  const result = await written(
    db,
    context,
    sourceId,
    intents,
    async (run, change) => {
      await recordIntents(db, context, sourceId, planned);
      intents.push(...planned);
      const ids: string[] = [];
      for (const statement of statements) {
        const added = await change(statement.sql);
        const id = statement.inserted
          ? (await run(statement.inserted))[0]?.id
          : added.rows[0]?.id;
        if (typeof id !== "string" && typeof id !== "number") {
          throw new AppError("source_row_key_unknown");
        }
        ids.push(String(id));
        if (statement.side.length > 0) {
          await change(buildSideUpsert(table, String(id), statement.side));
        }
      }
      const read = await readRows(context, run, ids, fields);
      return { ids, read };
    },
  );
  for (let index = 0; index < statements.length; index += 1) {
    const statement = statements[index];
    const rowId = result.ids[index];
    if (!statement || !rowId || statement.controlPlane.length === 0) continue;
    const bag: Record<string, unknown> = {};
    for (const item of statement.controlPlane) bag[item.column.id] = item.value;
    await upsertEnrichmentValues(db, {
      tableId: context.table.id,
      rowId,
      userId: context.userId,
      patch: bag,
    });
  }
  await recordApplied(
    db,
    context,
    intents.map((intent, index) => {
      const rowId = result.ids[index] ?? "";
      return {
        intent,
        rowId,
        row: pick(result.read.get(rowId), fields),
      };
    }),
  );
  return result.ids;
}

/** Deletes rows; the trail keeps what they held. */
export async function deleteExternalRows(
  db: Database,
  context: ExternalWriteContext,
  rowIds: readonly string[],
  fields: readonly string[],
): Promise<string[]> {
  const sourceId = assertEnabled(context, "delete");
  const ids = [...new Set(rowIds)];
  if (ids.length === 0) return [];
  const table = context.engine.table;
  await assertUnsealed(db, context.table.id, ids);
  const statements = ids.map((id) => buildExternalDelete(table, id));
  const intents: Intent[] = [];
  await written(db, context, sourceId, intents, async (run, change) => {
    for (const chunk of chunks(ids)) {
      await run(buildExternalLock(table, chunk));
    }
    const current = await readRows(context, run, ids, fields);
    const planned = ids.map((id): Intent => {
      if (!current.has(id)) throw new AppError("source_row_missing");
      return {
        id: randomUUID(),
        rowId: id,
        action: "delete",
        oldValue: pick(current.get(id), fields),
        newValue: null,
      };
    });
    await recordIntents(db, context, sourceId, planned);
    intents.push(...planned);
    await assertUnsealed(db, context.table.id, ids);
    for (const statement of statements) await change(statement);
    // The side values of a deleted row go with it.
    if (table.external?.side) {
      for (const id of ids) await change(buildSideDelete(table, id));
    }
  });
  await recordApplied(
    db,
    context,
    intents.map((intent) => ({
      intent,
      rowId: intent.rowId ?? "",
      row: null,
    })),
  );
  await forgetStatuses(db, context.table.id, ids);
  return ids;
}

/** Intents with no outcome this long after were cut short: read the row. */
const STALE_AFTER_MS = 15 * 60_000;
/** Older entries are left as they are: the job ran on them long ago. */
const SETTLE_WINDOW_MS = 7 * 86_400_000;
const SETTLE_BATCH = 200;

/** A field the row no longer has: it equals nothing. */
const GONE = Symbol("gone");

/** What a row held in each field just after a write. */
type ValueAfter = (name: string) => unknown;

/** The row held these values, links compared by the key they point to. */
function holds(valueOf: ValueAfter, values: unknown): boolean {
  if (!values || typeof values !== "object") return false;
  return Object.entries(values as Record<string, unknown>).every(
    ([name, value]) => {
      const found = valueOf(name);
      return found !== GONE && sameCell(linkKey(found), linkKey(value));
    },
  );
}

type OpenWrite = {
  id: string;
  tableId: string;
  rowId: string | null;
  action: string;
  oldValue: unknown;
  newValue: unknown;
  requestedAt: Date;
  applied: unknown;
};

type Later = { rowId: string | null; requestedAt: Date; oldValue: unknown };

/**
 * What the row held in each field just after `write`: what the next write
 * through AnyGridDB that changed the field read there under lock, else
 * what the row holds now. A write since does not make an earlier one
 * unverifiable: the later one saw it.
 */
function valueAfter(
  write: OpenWrite,
  row: Record<string, unknown> | undefined,
  later: readonly Later[],
): ValueAfter {
  return (name) => {
    for (const next of later) {
      if (next.requestedAt <= write.requestedAt) continue;
      const old = next.oldValue;
      if (old && typeof old === "object" && Object.hasOwn(old, name)) {
        return (old as Record<string, unknown>)[name];
      }
    }
    return row && Object.hasOwn(row, name) ? row[name] : GONE;
  };
}

/** What reading the row again says about one open write. */
function outcome(
  write: OpenWrite,
  rowId: string | null,
  row: Record<string, unknown> | undefined,
  later: readonly Later[],
): Array<{ step: Step; detail: unknown }> {
  const applied =
    write.applied && typeof write.applied === "object"
      ? (write.applied as { row?: unknown })
      : null;
  const now = { row: row ?? null };
  const valueOf = valueAfter(write, row, later);
  const after = later.some((next) => next.requestedAt > write.requestedAt);
  if (applied) {
    const shown =
      write.action === "delete"
        ? row === undefined || after
        : holds(valueOf, applied.row ?? write.newValue);
    return [
      { step: shown ? "confirmed" : "unverified", detail: shown ? null : now },
    ];
  }
  // The client's transaction may or may not have committed.
  if (write.action === "insert" || rowId === null) {
    return [{ step: "unverified", detail: { reason: "key_unknown" } }];
  }
  const done =
    write.action === "delete"
      ? row === undefined
      : holds(valueOf, write.newValue);
  if (done) {
    return [
      { step: "applied", detail: { rowId, row: row ?? null, settled: true } },
      { step: "confirmed", detail: null },
    ];
  }
  if (holds(valueOf, write.oldValue)) {
    return [{ step: "abandoned", detail: null }];
  }
  return [{ step: "unverified", detail: now }];
}

/**
 * Settles open writes by reading their rows again: confirms the ones
 * applied, and decides the intents a crash or a lost connection left
 * without an outcome. A source it cannot reach is tried again next time.
 */
export async function settleExternalWrites(
  db: Database,
  log: (error: unknown, message: string) => void,
): Promise<number> {
  const now = Date.now();
  const open: OpenWrite[] = await db
    .selectFrom("externalWrites as w")
    .leftJoin("externalWriteSteps as a", (join) =>
      join.onRef("a.writeId", "=", "w.id").on("a.step", "=", "applied"),
    )
    .select([
      "w.id",
      "w.tableId",
      "w.rowId",
      "w.action",
      "w.oldValue",
      "w.newValue",
      "w.requestedAt",
      "a.detail as applied",
    ])
    .where("w.requestedAt", ">", new Date(now - SETTLE_WINDOW_MS))
    .where((eb) =>
      eb.and([
        eb.not(
          eb.exists(
            eb
              .selectFrom("externalWriteSteps as s")
              .select("s.writeId")
              .whereRef("s.writeId", "=", "w.id")
              .where("s.step", "in", ["confirmed", "abandoned", "unverified"]),
          ),
        ),
        eb.or([
          eb("a.writeId", "is not", null),
          eb("w.requestedAt", "<", new Date(now - STALE_AFTER_MS)),
        ]),
      ]),
    )
    .orderBy("w.requestedAt")
    .limit(SETTLE_BATCH)
    .execute();
  const byTable = new Map<string, OpenWrite[]>();
  for (const write of open) {
    byTable.set(write.tableId, [...(byTable.get(write.tableId) ?? []), write]);
  }
  let settled = 0;
  for (const [tableId, writes] of byTable) {
    const rowIdOf = (write: OpenWrite): string | null => {
      if (write.rowId) return write.rowId;
      const applied = write.applied as { rowId?: unknown } | null;
      return typeof applied?.rowId === "string" ? applied.rowId : null;
    };
    const ids = [
      ...new Set(writes.map(rowIdOf).filter((id): id is string => id !== null)),
    ];
    // Writes through AnyGridDB on the same rows since, oldest first.
    const since = writes.reduce(
      (first, write) => (write.requestedAt < first ? write.requestedAt : first),
      new Date(now),
    );
    const later: Later[] =
      ids.length === 0
        ? []
        : await db
            .selectFrom("externalWrites")
            .select(["rowId", "requestedAt", "oldValue"])
            .where("tableId", "=", tableId)
            .where("rowId", "in", ids)
            .where("requestedAt", ">", since)
            .orderBy("requestedAt")
            .execute();
    let rows: Map<string, Record<string, unknown>>;
    try {
      const { engine } = await loadEngine(db, tableId, () => true);
      rows = new Map();
      for (const chunk of chunks(ids)) {
        for (const row of await readByIds(db, engine, chunk, "UTC")) {
          rows.set(row.id, row);
        }
      }
    } catch (error) {
      if (error instanceof AppError && error.code === "unknown_table") {
        // The table left AnyGridDB: nothing can be read again.
        await recordSteps(
          db,
          writes.map((write) => ({
            writeId: write.id,
            step: "unverified" as const,
            detail: { reason: "table_gone" },
          })),
        );
        settled += writes.length;
      } else {
        log(error, "external write settle failed");
      }
      continue;
    }
    const steps = writes.flatMap((write) => {
      const rowId = rowIdOf(write);
      return outcome(
        write,
        rowId,
        rowId ? rows.get(rowId) : undefined,
        later.filter((next) => next.rowId === rowId),
      ).map((step) => ({ writeId: write.id, ...step }));
    });
    await recordSteps(db, steps);
    settled += writes.length;
  }
  return settled;
}

/** Where a write through AnyGridDB stands, as the row history shows it. */
export type WriteState = "pending" | "applied" | "confirmed" | "unverified";

/**
 * A client row's history: the writes made through AnyGridDB, newest
 * first, with where each stands. Abandoned ones changed nothing and are
 * left out; writes made by other applications are not known here.
 */
export async function readExternalAudit(
  db: Database,
  tableId: string,
  rowId: string,
  hidden: (column: string) => boolean = () => false,
) {
  const writes = await db
    .selectFrom("externalWrites as w")
    .innerJoin("users as u", "u.id", "w.userId")
    .leftJoin("externalWriteSteps as a", (join) =>
      join.onRef("a.writeId", "=", "w.id").on("a.step", "=", "applied"),
    )
    .select([
      "w.id",
      "w.requestedAt",
      "w.userId",
      "u.displayName",
      "w.action",
      "w.oldValue",
      "w.newValue",
      "w.reason",
      "w.source",
      "a.writeId as applied",
    ])
    .where("w.tableId", "=", tableId)
    .where((eb) =>
      eb.or([
        eb("w.rowId", "=", rowId),
        eb(sql<string>`a.detail ->> 'rowId'`, "=", rowId),
      ]),
    )
    .orderBy("w.requestedAt", "desc")
    .limit(200)
    .execute();
  const steps =
    writes.length === 0
      ? []
      : await db
          .selectFrom("externalWriteSteps")
          .select(["writeId", "step"])
          .where(
            "writeId",
            "in",
            writes.map((write) => write.id),
          )
          .execute();
  const stepsOf = (id: string) =>
    new Set(
      steps.filter((step) => step.writeId === id).map((step) => step.step),
    );
  const visible = (value: unknown): unknown => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return value ?? null;
    }
    return Object.fromEntries(
      Object.entries(value).filter(([name]) => !hidden(name)),
    );
  };
  return writes
    .filter((write) => !stepsOf(write.id).has("abandoned"))
    .map((write) => {
      const done = stepsOf(write.id);
      const state: WriteState = done.has("confirmed")
        ? "confirmed"
        : done.has("unverified")
          ? "unverified"
          : write.applied
            ? "applied"
            : "pending";
      return {
        occurredAt: write.requestedAt.toISOString(),
        userId: write.userId,
        displayName: write.displayName,
        action: write.action,
        oldValue: visible(write.oldValue),
        newValue: visible(write.newValue),
        reason: write.reason,
        source: write.source,
        state,
      };
    });
}

/** How long a row deleted through AnyGridDB can be put back (ADR 0007). */
const TRASH_DAYS = 30;

type DeletedRow = {
  id: string;
  rowId: string;
  oldValue: unknown;
  requestedAt: Date;
  displayName: string;
};

/**
 * Rows of a client's table deleted through AnyGridDB in the last 30 days
 * and not put back since: each one's last delete, newest first.
 */
async function deletedRows(
  db: Database,
  tableId: string,
  rowIds: readonly string[] | null,
  limit: number,
): Promise<DeletedRow[]> {
  let query = db
    .selectFrom("externalWrites as w")
    .innerJoin("externalWriteSteps as a", (join) =>
      join.onRef("a.writeId", "=", "w.id").on("a.step", "=", "applied"),
    )
    .innerJoin("users as u", "u.id", "w.userId")
    .select(["w.id", "w.rowId", "w.oldValue", "w.requestedAt", "u.displayName"])
    .where("w.tableId", "=", tableId)
    .where("w.action", "=", "delete")
    .where("w.rowId", "is not", null)
    .where("w.requestedAt", ">", new Date(Date.now() - TRASH_DAYS * 86_400_000))
    // Put back from the trash, under any key: no longer in it.
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom("externalWrites as r")
            .innerJoin("externalWriteSteps as t", (join) =>
              join.onRef("t.writeId", "=", "r.id").on("t.step", "=", "applied"),
            )
            .select("r.id")
            .whereRef("r.restores", "=", "w.id"),
        ),
      ),
    )
    // Added again under its key since: no longer in the trash either.
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom("externalWrites as i")
            .innerJoin("externalWriteSteps as s", (join) =>
              join.onRef("s.writeId", "=", "i.id").on("s.step", "=", "applied"),
            )
            .select("i.id")
            .whereRef("i.tableId", "=", "w.tableId")
            .where("i.action", "=", "insert")
            .whereRef("i.requestedAt", ">", "w.requestedAt")
            .where(sql<boolean>`s.detail ->> 'rowId' = w.row_id`),
        ),
      ),
    )
    .orderBy("w.requestedAt", "desc")
    .limit(limit);
  if (rowIds) query = query.where("w.rowId", "in", [...rowIds]);
  const rows = await query.execute();
  // A row deleted twice shows once, by its last delete.
  const seen = new Set<string>();
  return rows.flatMap((row) => {
    if (!row.rowId || seen.has(row.rowId)) return [];
    seen.add(row.rowId);
    return [
      {
        id: row.id,
        rowId: row.rowId,
        oldValue: row.oldValue,
        requestedAt: row.requestedAt,
        displayName: row.displayName,
      },
    ];
  });
}

/** A client table's row trash, as the trash dialog lists it. */
export async function listExternalTrash(
  db: Database,
  engine: EngineCatalog,
  limit: number,
) {
  const primary = engine.table.primaryColumn;
  const rows = await deletedRows(db, engine.table.id, null, limit);
  return rows.map((row) => {
    const values = (row.oldValue ?? {}) as Record<string, unknown>;
    const label = primary ? linkKey(values[primary]) : null;
    return {
      rowId: row.rowId,
      label:
        typeof label === "string" || typeof label === "number"
          ? String(label)
          : row.rowId,
      deletedAt: row.requestedAt.toISOString(),
      deletedBy: row.displayName,
    };
  });
}

/**
 * Puts rows deleted through AnyGridDB back, best effort (ADR 0007): each
 * one is added again with the stored values its delete recorded, through
 * the compared, recorded write path. Fields the account may not fill on a
 * new row are left to the client's defaults; a key the client makes
 * again gives the row a new id.
 */
export async function restoreExternalRows(
  db: Database,
  context: ExternalWriteContext,
  rowIds: readonly string[],
): Promise<string[]> {
  const deleted = await deletedRows(
    db,
    context.table.id,
    [...new Set(rowIds)],
    rowIds.length,
  );
  if (deleted.length !== new Set(rowIds).size) {
    throw new AppError("no_row");
  }
  const insertable = new Set(
    context.catalog.columns
      .filter(
        (column) =>
          column.tableId === context.table.id && column.externalInsertable,
      )
      .map((column) => column.name),
  );
  const rows = deleted.map((row) => {
    const old = (row.oldValue ?? {}) as Record<string, unknown>;
    const values: Record<string, CellValue> = {};
    for (const column of context.engine.table.columns) {
      if (!column.physical || !insertable.has(column.name)) continue;
      if (!Object.hasOwn(old, column.name)) continue;
      values[column.name] = (
        column.relation ? linkKey(old[column.name]) : old[column.name]
      ) as CellValue;
    }
    return values;
  });
  return insertExternalRows(
    db,
    context,
    rows,
    deleted.map((row) => row.id),
  );
}
