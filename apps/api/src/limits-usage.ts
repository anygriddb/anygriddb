/**
 * Administration's "Limits and usage" (ADR 0132): every limit of the
 * catalogue as the instance keeps it now, and what is used of it where
 * the instance counts it. Counts, never who: no address, no account.
 */
import {
  LIMITS,
  limitIn,
  resolveAttachmentMaxBytes,
  type InstanceSettings,
  type LimitEntry,
  type LimitId,
  type LimitSetBy,
  type SettableLimitId,
} from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { sql } from "kysely";
import type { Env } from "./env.js";
import { BUCKET_LIMITS } from "./rate-limit.js";

/**
 * What is used of a limit: the most any one of what it counts (an address,
 * an account) holds now, and how many hold more than it allows (an
 * address refused) or all it allows (an account that can start nothing).
 */
export type LimitUse = { most: number; past: number };

export type LimitRow = LimitEntry & {
  id: LimitId;
  /** The value the instance keeps to now: as set, by the environment, or shipped. */
  now: number;
  used: LimitUse | null;
};

/** What the requests of each kind used, over this minute and the one before. */
async function rateUse(
  db: Database,
  settings: InstanceSettings,
): Promise<Map<SettableLimitId, LimitUse>> {
  const limits = Object.fromEntries(
    Object.entries(BUCKET_LIMITS).map(([bucket, id]) => [
      bucket,
      limitIn(id, settings.limits),
    ]),
  );
  const { rows } = await sql<{ bucket: string; most: number; past: number }>`
    select b.bucket,
           max(w.hits)::int as most,
           count(distinct w."key") filter (
             where w.hits > (${JSON.stringify(limits)}::jsonb ->> b.bucket)::int
           )::int as past
      from rate_windows w
     cross join lateral (
       select right(w."key", strpos(reverse(w."key"), ':') - 1) as bucket
     ) b
     where w.window_start >= date_bin(
             interval '1 minute', now(), timestamptz 'epoch'
           ) - interval '1 minute'
     group by b.bucket
  `.execute(db);
  const use = new Map<SettableLimitId, LimitUse>();
  for (const row of rows) {
    if (!Object.hasOwn(BUCKET_LIMITS, row.bucket)) continue;
    const id = BUCKET_LIMITS[row.bucket as keyof typeof BUCKET_LIMITS];
    use.set(id, { most: row.most, past: row.past });
  }
  return use;
}

/** Jobs queued or running: the most one account holds, and how many hold all they may. */
async function jobsUse(
  db: Database,
  settings: InstanceSettings,
): Promise<LimitUse> {
  const limit = limitIn("jobs.active_per_account", settings.limits);
  const { rows } = await sql<{ most: number; past: number }>`
    select coalesce(max(n), 0)::int as most,
           count(*) filter (where n >= ${limit})::int as past
      from (
        select count(*) as n
          from jobs
         where status in ('queued', 'running')
         group by user_id
      ) held
  `.execute(db);
  return rows[0] ?? { most: 0, past: 0 };
}

/** What the environment fixes of a limit, when it does (ADR 0083). */
function fixedByEnv(entry: LimitEntry, env: Env): number | undefined {
  return entry.fixedBy === undefined ? undefined : env[entry.fixedBy];
}

/**
 * Live connections: the most one account holds across the instance, and
 * how many hold all they may. Rows a stopped process left are not counted.
 */
async function socketsUse(
  db: Database,
  settings: InstanceSettings,
): Promise<LimitUse> {
  const limit = limitIn("sockets.per_account", settings.limits);
  const { rows } = await sql<{ most: number; past: number }>`
    select coalesce(max(n), 0)::int as most,
           count(*) filter (where n >= ${limit})::int as past
      from (
        select sum("open") as n
          from live_sockets
         where seen_at > now() - interval '90 seconds'
         group by user_id
      ) held
  `.execute(db);
  return rows[0] ?? { most: 0, past: 0 };
}

/** The value a limit has now, wherever it is set. */
function valueNow(id: LimitId, settings: InstanceSettings, env: Env): number {
  switch (id) {
    case "attachment.max_bytes":
      return resolveAttachmentMaxBytes(settings, env.ATTACHMENT_MAX_BYTES);
    case "retention.trash_days":
      return settings.trashDays;
    case "retention.restore_point_days":
      return settings.restorePointDays;
    case "retention.sign_in_days":
      return settings.authRetentionDays;
    default: {
      const entry: LimitEntry = LIMITS[id];
      return entry.setBy === "limits"
        ? (fixedByEnv(entry, env) ??
            limitIn(id as SettableLimitId, settings.limits))
        : entry.value;
    }
  }
}

export async function limitsAndUsage(
  db: Database,
  env: Env,
  settings: InstanceSettings,
): Promise<LimitRow[]> {
  const [rates, jobs, sockets] = await Promise.all([
    rateUse(db, settings),
    jobsUse(db, settings),
    socketsUse(db, settings),
  ]);
  const counted = new Set<LimitId>(Object.values(BUCKET_LIMITS));
  return (Object.keys(LIMITS) as LimitId[]).map((id) => {
    const entry: LimitEntry = LIMITS[id];
    const used =
      id === "jobs.active_per_account"
        ? jobs
        : id === "sockets.per_account"
          ? sockets
          : counted.has(id)
            ? (rates.get(id as SettableLimitId) ?? { most: 0, past: 0 })
            : null;
    // What the environment fixes is its operator's to change (ADR 0083).
    const setBy: LimitSetBy =
      fixedByEnv(entry, env) === undefined ? entry.setBy : "environment";
    return { ...entry, id, setBy, now: valueNow(id, settings, env), used };
  });
}
