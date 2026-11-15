/**
 * `/ready`: whether this process can serve a request now. `/health` says
 * the process is up, and that is what restarts it; a load balancer or a
 * monitor asks here instead, and sends requests elsewhere, or raises an
 * alert, while PostgreSQL does not answer or every connection of the pool
 * is taken.
 */

/** How long the database has to answer before the process is not ready. */
const READY_WITHIN_MS = 2_000;
/** An answer is kept this long: probes cost one query a second at most. */
const KEEP_MS = 1_000;

type Readiness = {
  ok: boolean;
  database: boolean;
  /** The listening connection of realtime; down, pages re-read on their own. */
  realtime: boolean;
  /**
   * Present when the caller asks: every migration this process knows is
   * recorded. Absent on `/ready`, which stays the database check Compose uses.
   */
  migrations?: boolean;
};

/** True when every expected migration name has been applied. */
export function migrationsCurrent(
  applied: readonly string[],
  expected: readonly string[],
): boolean {
  if (expected.length === 0) return false;
  const have = new Set(applied);
  return expected.every((name) => have.has(name));
}

async function answers(
  ping: () => Promise<unknown>,
  withinMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<false>((resolve) => {
    timer = setTimeout(() => {
      resolve(false);
    }, withinMs);
  });
  try {
    return await Promise.race([
      // A ping that fails after the limit has nobody left to tell.
      ping().then(
        () => true,
        () => false,
      ),
      late,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Builds the probe. Ready means the database answered in time: realtime
 * is reported, but a listener that reconnects does not stop requests.
 */
export function readinessProbe(deps: {
  ping: () => Promise<unknown>;
  listening: () => boolean;
  /** When set, readiness also requires these migrations to be applied. */
  migrations?: () => Promise<boolean>;
  withinMs?: number;
  now?: () => number;
}): () => Promise<Readiness> {
  const now = deps.now ?? Date.now;
  let last: { at: number; value: Promise<Readiness> } | undefined;
  return () => {
    if (last && now() - last.at < KEEP_MS) return last.value;
    const value = Promise.all([
      answers(deps.ping, deps.withinMs ?? READY_WITHIN_MS),
      deps.migrations
        ? deps.migrations().then(
            (current) => current,
            () => false,
          )
        : undefined,
    ]).then(([database, migrations]) => ({
      ok: database && migrations !== false,
      database,
      realtime: deps.listening(),
      ...(migrations === undefined ? {} : { migrations }),
    }));
    last = { at: now(), value };
    return value;
  };
}
