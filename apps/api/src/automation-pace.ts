/**
 * How fast one automation runs (ADR 0115). Past its limit a run waits for a
 * minute of its own: it is given one once, so that a burst queues each of
 * its runs one more time and no more, then starts when that minute comes.
 * The counts live in PostgreSQL, each moved in one statement, so that every
 * process holds the same limit.
 */
import type { Executor } from "@anygriddb/db";
import { sql } from "kysely";
import { limitIn, type LimitValues } from "@anygriddb/core";

/**
 * Runs one automation may start per minute, whatever triggers it, and how
 * long a run may wait for its turn: past it, it is dropped and said so.
 */
export type Pace = { perMinute: number; maxDelayMinutes: number };

/** The pace as Administration sets it, else the catalogue's (ADR 0132). */
export function paceIn(values: LimitValues): Pace {
  return {
    perMinute: limitIn("automation.runs_per_minute", values),
    maxDelayMinutes: limitIn("automation.max_delay_minutes", values),
  };
}

/** A minute's waiting runs start spread over this much of it. */
const SPREAD_MS = 55_000;

/** The database's clock; a test may give its own. */
function instant(at: Date | undefined) {
  return at ? sql`${at.toISOString()}::timestamptz` : sql`now()`;
}

/**
 * Gives a run the first minute with a place left. `due` when that is this
 * minute; otherwise `runAt` says when to start it. Null when every minute
 * of the next day is taken.
 */
export async function reserveMinute(
  executor: Executor,
  automationId: string,
  pace: Pace,
  at?: Date,
): Promise<{ due: boolean; runAt: Date } | null> {
  const now = instant(at);
  const minute = sql`date_trunc('minute', ${now})`;
  // The last minute given stays within the bound, its last place included.
  const last = pace.maxDelayMinutes - 1;
  const { rows } = await sql<{ minute: Date; place: number; due: boolean }>`
    insert into automation_run_pace as p
      (automation_id, started_minute, started, reserved_minute, reserved)
    values (${automationId}, ${minute}, 0, ${minute}, 1)
    on conflict (automation_id) do update set
      reserved_minute = case
        when p.reserved_minute < excluded.reserved_minute
          then excluded.reserved_minute
        when p.reserved >= ${pace.perMinute}
          then p.reserved_minute + interval '1 minute'
        else p.reserved_minute
      end,
      reserved = case
        when p.reserved_minute < excluded.reserved_minute then 1
        when p.reserved >= ${pace.perMinute} then 1
        else p.reserved + 1
      end
    where p.reserved_minute
            < excluded.reserved_minute + make_interval(mins => ${last}::int)
       or p.reserved < ${pace.perMinute}
    returning reserved_minute as minute, reserved as place,
              reserved_minute <= ${minute} as due
  `.execute(executor);
  const [row] = rows;
  if (!row) return null;
  const within = Math.floor(((row.place - 1) * SPREAD_MS) / pace.perMinute);
  return { due: row.due, runAt: new Date(row.minute.getTime() + within) };
}

/**
 * Counts a run that starts now. Null when this minute's starts are all
 * taken, by runs that came late to theirs. What it answers is when it
 * started, by the clock the limit is held on.
 */
export async function startRun(
  executor: Executor,
  automationId: string,
  pace: Pace,
  at?: Date,
): Promise<Date | null> {
  const now = instant(at);
  const minute = sql`date_trunc('minute', ${now})`;
  const { rows } = await sql<{ startedAt: Date }>`
    insert into automation_run_pace as p
      (automation_id, started_minute, started, reserved_minute, reserved)
    values (${automationId}, ${minute}, 1, ${minute}, 0)
    on conflict (automation_id) do update set
      started_minute = greatest(p.started_minute, excluded.started_minute),
      started = case
        when p.started_minute < excluded.started_minute then 1
        else p.started + 1
      end
    where p.started_minute < excluded.started_minute
       or p.started < ${pace.perMinute}
    returning ${now} as started_at
  `.execute(executor);
  return rows[0]?.startedAt ?? null;
}

/** The next minute by the clock the limit is held on, never one gone by. */
export async function nextMinute(executor: Executor, at?: Date): Promise<Date> {
  const { rows } = await sql<{ minute: Date }>`
    select date_trunc('minute', ${instant(at)}) + interval '1 minute' as minute
  `.execute(executor);
  const [row] = rows;
  if (!row) throw new Error("no clock");
  return row.minute;
}

/**
 * Gives back the minutes held for waiting runs, when an automation is
 * switched off: they will do nothing, and must not delay the next ones.
 */
export async function releaseWaitingRuns(
  executor: Executor,
  automationId: string,
): Promise<void> {
  await sql`
    update automation_run_pace
       set reserved_minute = started_minute, reserved = started
     where automation_id = ${automationId}
  `.execute(executor);
}

/** True once a day at most: whether this dropped run is the one to tell. */
export async function firstDropToTell(
  executor: Executor,
  automationId: string,
  at?: Date,
): Promise<boolean> {
  const now = instant(at);
  const { rows } = await sql`
    update automation_run_pace
       set dropped_told_at = ${now}
     where automation_id = ${automationId}
       and (dropped_told_at is null
            or dropped_told_at < ${now} - interval '24 hours')
    returning automation_id
  `.execute(executor);
  return rows.length > 0;
}
