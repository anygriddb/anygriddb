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
async function jobsUse(db: Database): Promise<LimitUse> {
  const limit = LIMITS["jobs.active_per_account"].value;
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

/** The value a limit has now, wherever it is set. */
function valueNow(id: LimitId, settings: InstanceSettings, env: Env): number {
  switch (id) {
    case "attachment.max_bytes":
      return resolveAttachmentMaxBytes(settings, env.ATTACHMENT_MAX_BYTES);
    case "import.max_rows":
      return env.IMPORT_MAX_ROWS;
    case "export.max_rows":
      return env.EXPORT_MAX_ROWS;
    case "retention.trash_days":
      return settings.trashDays;
    case "retention.restore_point_days":
      return settings.restorePointDays;
    case "retention.sign_in_days":
      return settings.authRetentionDays;
    default: {
      const entry: LimitEntry = LIMITS[id];
      return entry.setBy === "limits"
        ? limitIn(id as SettableLimitId, settings.limits)
        : entry.value;
    }
  }
}

export async function limitsAndUsage(
  db: Database,
  env: Env,
  settings: InstanceSettings,
): Promise<LimitRow[]> {
  const [rates, jobs] = await Promise.all([rateUse(db, settings), jobsUse(db)]);
  return (Object.keys(LIMITS) as LimitId[]).map((id) => {
    const entry: LimitEntry = LIMITS[id];
    const used =
      id === "jobs.active_per_account"
        ? jobs
        : entry.setBy === "limits"
          ? (rates.get(id as SettableLimitId) ?? { most: 0, past: 0 })
          : null;
    return { ...entry, id, now: valueNow(id, settings, env), used };
  });
}
