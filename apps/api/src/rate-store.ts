import type { Database } from "@anygriddb/db";
import { sql } from "kysely";

/** What a rate limit's store answers: the count so far, and when it ends. */
type Count = { current: number; ttl: number };
type Answer = (error: Error | null, count?: Count) => void;

/** How long a window's row is kept after it ends: two of them. */
const KEPT_WINDOWS = 2;

/**
 * How long a request waits for its count. Past it the request goes on
 * uncounted: a pool busy with long reads must not hold every request
 * behind it, the app's own pages included.
 */
export const COUNT_WAIT_MS = 2_000;

/** A failure to count is said at most once a minute: an outage says it once. */
const SAID_EVERY_MS = 60_000;

class CountTooSlow extends Error {
  constructor() {
    super("rate count too slow");
    this.name = "CountTooSlow";
  }
}

function within<T>(promise: Promise<T>, waitMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new CountTooSlow()), waitMs);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/**
 * Counts requests in PostgreSQL (ADR 0132), one window of `timeWindow` a
 * key, shared by every process of the instance: a limit is the limit,
 * however many processes serve it. The window is the database's, so that
 * processes whose clocks differ count in the same one. A count that fails
 * or waits past `COUNT_WAIT_MS` is an error the limiter lets through, and
 * is said to `warn` once a minute at most.
 */
export function rateStoreIn(
  db: Database,
  options: { warn: (error: unknown) => void; waitMs?: number },
) {
  const said = { at: Number.NEGATIVE_INFINITY };
  const count = (key: string, timeWindow: number, add: boolean) => {
    const stride = sql.lit(`${String(timeWindow)} milliseconds`);
    const start = sql`date_bin(${stride}::interval, now(), timestamptz 'epoch')`;
    const ttl = sql`ceil(extract(epoch from w.window_start + ${stride}::interval - now()) * 1000)::int`;
    return add
      ? sql<{ hits: number; ttl: number }>`
          insert into rate_windows as w ("key", window_start, hits)
          values (${key}, ${start}, 1)
          on conflict ("key", window_start) do update set hits = w.hits + 1
          returning w.hits, ${ttl} as ttl
        `.execute(db)
      : sql<{ hits: number; ttl: number }>`
          select w.hits, ${ttl} as ttl
            from rate_windows w
           where w."key" = ${key} and w.window_start = ${start}
        `.execute(db);
  };
  const answer = (
    promise: ReturnType<typeof count>,
    callback: Answer,
  ): void => {
    within(promise, options.waitMs ?? COUNT_WAIT_MS).then(
      ({ rows }) => {
        const [row] = rows;
        callback(null, { current: row?.hits ?? 0, ttl: row?.ttl ?? 0 });
      },
      (error: unknown) => {
        const now = Date.now();
        if (now - said.at >= SAID_EVERY_MS) {
          said.at = now;
          options.warn(error);
        }
        callback(error instanceof Error ? error : new Error("rate count"));
      },
    );
  };
  return class PostgresRateStore {
    incr(key: string, callback: Answer, timeWindow: number): void {
      answer(count(key, timeWindow, true), callback);
    }

    read(key: string, callback: Answer, timeWindow: number): void {
      answer(count(key, timeWindow, false), callback);
    }

    child(): this {
      return this;
    }
  };
}

/** Removes the windows that ended, from every key at once. */
export async function pruneRateWindows(
  db: Database,
  timeWindow: number,
): Promise<void> {
  const kept = sql.lit(`${String(timeWindow * KEPT_WINDOWS)} milliseconds`);
  await sql`delete from rate_windows where window_start < now() - ${kept}::interval`.execute(
    db,
  );
}
