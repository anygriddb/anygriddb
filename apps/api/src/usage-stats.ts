/**
 * Usage figures for Administration (ROADMAP #40): accounts and bases
 * active over the last 30 days, with a daily snapshot so a trend does
 * not depend on who is active now. A base is active when one of its
 * tables was used in the window (`lastActivity`): each table's newest
 * event is read by the trails' indexes, never by scanning a trail.
 */
import { ceilingOf } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { sql } from "kysely";
import { ERASED_USER_ID } from "./data/erasure.js";
import { lastActivity } from "./data/table-activity.js";

const DAY_MS = 86_400_000;
const WINDOW_DAYS = ceilingOf("usage.active_days");
/** How many daily points Health keeps and shows. */
export const USAGE_TREND_DAYS = ceilingOf("usage.trend_days");

export type UsageSnapshot = {
  day: string;
  accountsActive30d: number;
  basesActive30d: number;
  accountsTotal: number;
  basesTotal: number;
};

export type UsageFigures = {
  /** Counts as of this request. */
  current: Omit<UsageSnapshot, "day"> & { asOf: string };
  /** Oldest first, at most USAGE_TREND_DAYS rows. */
  trend: UsageSnapshot[];
};

function dayKey(at: Date): string {
  return at.toISOString().slice(0, 10);
}

function sinceDays(at: Date, days: number): Date {
  return new Date(at.getTime() - days * DAY_MS);
}

/** Live counts for the rolling 30-day window ending at `at`. */
export async function countUsageNow(
  db: Database,
  at: Date = new Date(),
): Promise<Omit<UsageSnapshot, "day">> {
  const since = sinceDays(at, WINDOW_DAYS);
  const [accounts, bases, totals] = await Promise.all([
    db
      .selectFrom("users")
      .select((eb) => eb.fn.countAll<string>().as("n"))
      .where("id", "<>", ERASED_USER_ID)
      .where("activeAt", ">", since)
      .executeTakeFirstOrThrow(),
    sql<{ n: string }>`
      select count(distinct t.base_id)::text as n
      from data_tables t
      join bases b on b.id = t.base_id
      where t.deleted_at is null
        and b.deleted_at is null
        and ${lastActivity("t")} > ${since}
    `.execute(db),
    Promise.all([
      db
        .selectFrom("users")
        .select((eb) => eb.fn.countAll<string>().as("n"))
        .where("id", "<>", ERASED_USER_ID)
        .executeTakeFirstOrThrow(),
      db
        .selectFrom("bases")
        .select((eb) => eb.fn.countAll<string>().as("n"))
        .where("deletedAt", "is", null)
        .executeTakeFirstOrThrow(),
    ]),
  ]);
  return {
    accountsActive30d: Number(accounts.n),
    basesActive30d: Number(bases.rows[0]?.n ?? 0),
    accountsTotal: Number(totals[0].n),
    basesTotal: Number(totals[1].n),
  };
}

/**
 * Writes today's row (upsert). Safe to call from the nightly job and from
 * a Health read so the trend has a point before the cron runs.
 */
export async function snapshotUsage(
  db: Database,
  at: Date = new Date(),
): Promise<UsageSnapshot> {
  const counts = await countUsageNow(db, at);
  const day = dayKey(at);
  await sql`
    insert into usage_daily (
      day, accounts_active_30d, bases_active_30d, accounts_total, bases_total
    ) values (
      ${day}::date,
      ${counts.accountsActive30d},
      ${counts.basesActive30d},
      ${counts.accountsTotal},
      ${counts.basesTotal}
    )
    on conflict (day) do update set
      accounts_active_30d = excluded.accounts_active_30d,
      bases_active_30d = excluded.bases_active_30d,
      accounts_total = excluded.accounts_total,
      bases_total = excluded.bases_total
  `.execute(db);
  return { day, ...counts };
}

/** Drops daily rows older than the trend window. */
export async function purgeUsageDaily(
  db: Database,
  at: Date = new Date(),
): Promise<number> {
  const keepFrom = dayKey(sinceDays(at, USAGE_TREND_DAYS));
  const result = await sql`
    delete from usage_daily where day < ${keepFrom}::date
  `.execute(db);
  return Number(result.numAffectedRows ?? 0);
}

/** What Administration's Health page shows. */
export async function readUsage(
  db: Database,
  at: Date = new Date(),
): Promise<UsageFigures> {
  await snapshotUsage(db, at);
  const from = dayKey(sinceDays(at, USAGE_TREND_DAYS - 1));
  // CamelCasePlugin renames result keys to camelCase.
  const rows = await sql<{
    day: Date | string;
    accountsActive30d: number;
    basesActive30d: number;
    accountsTotal: number;
    basesTotal: number;
  }>`
    select day, accounts_active_30d, bases_active_30d, accounts_total, bases_total
    from usage_daily
    where day >= ${from}::date
    order by day asc
  `
    .execute(db)
    .then((result) => result.rows);
  const current = await countUsageNow(db, at);
  return {
    current: { ...current, asOf: at.toISOString() },
    trend: rows.map((row) => ({
      day: row.day instanceof Date ? dayKey(row.day) : row.day.slice(0, 10),
      accountsActive30d: row.accountsActive30d,
      basesActive30d: row.basesActive30d,
      accountsTotal: row.accountsTotal,
      basesTotal: row.basesTotal,
    })),
  };
}
