/**
 * Load by source for Administration (ROADMAP #41): every process records
 * each client-database operation into minute buckets. Health reads those
 * rows; it never reads the in-memory Prometheus counters, which are lost
 * at restart and partial with several processes.
 */
import type { Database } from "@anygriddb/db";
import { sql } from "kysely";

const DAY_MS = 86_400_000;
/** Keep minute buckets this long; Health shows up to the same window. */
const SOURCE_LOAD_KEEP_DAYS = 30;
/** An operation at or above this duration counts as slow (1 s). */
export const SOURCE_LOAD_SLOW_MS = 1_000;

type SourceLoadKind = "read" | "write";
type SourceLoadOutcome = "ok" | "error" | "timeout";

export type SourceLoadSample = {
  sourceId: string;
  kind: SourceLoadKind;
  outcome: SourceLoadOutcome;
  durationMs: number;
};

type SourceLoadRow = {
  sourceId: string;
  name: string;
  engine: string;
  ops: number;
  errors: number;
  timeouts: number;
  slow: number;
  totalMs: number;
};

export type SourceLoadFigures = {
  sinceDays: number;
  since: string;
  sources: SourceLoadRow[];
};

let writer: Database | null = null;

/** Called once at process start so measureSource can persist samples. */
export function registerSourceLoadWriter(db: Database): void {
  writer = db;
}

/**
 * One operation finished. Returns the write promise so tests can wait; the
 * live path voids it. Never rejects to the caller of measureSource: a
 * failed write must not fail the source transaction that already ran.
 */
export function recordSourceLoad(sample: SourceLoadSample): Promise<void> {
  if (!writer) return Promise.resolve();
  const db = writer;
  const errors = sample.outcome === "error" ? 1 : 0;
  const timeouts = sample.outcome === "timeout" ? 1 : 0;
  const slow = sample.durationMs >= SOURCE_LOAD_SLOW_MS ? 1 : 0;
  const totalMs = Math.max(0, Math.round(sample.durationMs));
  return sql`
    insert into source_load_minute (
      source_id, minute, kind, ops, errors, timeouts, slow, total_ms
    ) values (
      ${sample.sourceId}::uuid,
      date_trunc('minute', now()),
      ${sample.kind},
      1,
      ${errors},
      ${timeouts},
      ${slow},
      ${totalMs}
    )
    on conflict (source_id, minute, kind) do update set
      ops = source_load_minute.ops + 1,
      errors = source_load_minute.errors + excluded.errors,
      timeouts = source_load_minute.timeouts + excluded.timeouts,
      slow = source_load_minute.slow + excluded.slow,
      total_ms = source_load_minute.total_ms + excluded.total_ms
  `
    .execute(db)
    .then(() => undefined)
    .catch(() => {
      // A lost sample is better than failing a live source call.
    });
}

/** Drops minute buckets older than SOURCE_LOAD_KEEP_DAYS. */
export async function purgeSourceLoad(
  db: Database,
  at: Date = new Date(),
): Promise<number> {
  const keepFrom = new Date(at.getTime() - SOURCE_LOAD_KEEP_DAYS * DAY_MS);
  const result = await sql`
    delete from source_load_minute where minute < ${keepFrom}
  `.execute(db);
  return Number(result.numAffectedRows ?? 0);
}

/** Aggregates for Health, newest sources with trouble first. */
export async function readSourceLoad(
  db: Database,
  sinceDays: number = 7,
  at: Date = new Date(),
): Promise<SourceLoadFigures> {
  const days = Math.min(
    SOURCE_LOAD_KEEP_DAYS,
    Math.max(1, Math.trunc(sinceDays)),
  );
  const since = new Date(at.getTime() - days * DAY_MS);
  // CamelCasePlugin renames result keys: source_id → sourceId, total_ms → totalMs.
  const { rows } = await sql<{
    sourceId: string;
    name: string;
    engine: string;
    ops: string;
    errors: string;
    timeouts: string;
    slow: string;
    totalMs: string;
  }>`
    select
      s.id as source_id,
      s.name,
      s.engine,
      coalesce(sum(m.ops), 0)::text as ops,
      coalesce(sum(m.errors), 0)::text as errors,
      coalesce(sum(m.timeouts), 0)::text as timeouts,
      coalesce(sum(m.slow), 0)::text as slow,
      coalesce(sum(m.total_ms), 0)::text as total_ms
    from sources s
    left join source_load_minute m
      on m.source_id = s.id
     and m.minute >= ${since}
    group by s.id, s.name, s.engine
    having coalesce(sum(m.ops), 0) > 0
        or coalesce(sum(m.errors), 0) > 0
        or coalesce(sum(m.timeouts), 0) > 0
    order by
      coalesce(sum(m.errors), 0) + coalesce(sum(m.timeouts), 0) desc,
      coalesce(sum(m.slow), 0) desc,
      coalesce(sum(m.ops), 0) desc,
      s.name asc
  `.execute(db);
  return {
    sinceDays: days,
    since: since.toISOString(),
    sources: rows.map((row) => ({
      sourceId: row.sourceId,
      name: row.name,
      engine: row.engine,
      ops: Number(row.ops),
      errors: Number(row.errors),
      timeouts: Number(row.timeouts),
      slow: Number(row.slow),
      totalMs: Number(row.totalMs),
    })),
  };
}
