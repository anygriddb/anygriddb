import { measureJob } from "../observability.js";
import {
  Logger,
  parseCronItems,
  run,
  runMigrations,
  type CronItem,
  type LogFunctionFactory,
  type Runner,
  type TaskList,
} from "graphile-worker";
import pg from "pg";

export type QueueLog = {
  error: (meta: Record<string, unknown>, message: string) => void;
  warn: (meta: Record<string, unknown>, message: string) => void;
  info: (meta: Record<string, unknown>, message: string) => void;
  debug: (meta: Record<string, unknown>, message: string) => void;
};

/** graphile-worker's logs, in the API's structured log. */
function queueLogger(log: QueueLog): Logger {
  const factory: LogFunctionFactory = (scope) => (level, message, meta) => {
    const fields = { queue: scope, ...meta };
    if (level === "error") log.error(fields, message);
    else if (level === "warning") log.warn(fields, message);
    else if (level === "info") log.info(fields, message);
    else log.debug(fields, message);
  };
  return new Logger(factory);
}

/**
 * Creates or upgrades graphile-worker's schema. It needs no extension and
 * no superuser: only the right to create a schema in the database.
 */
export async function migrateQueue(
  connectionString: string,
  log: QueueLog,
): Promise<void> {
  const pool = new pg.Pool({ connectionString, max: 1 });
  const failed = (error: Error) => {
    log.error({ err: error }, "queue migration connection failed");
  };
  pool.on("error", failed);
  pool.on("connect", (client) => client.on("error", failed));
  try {
    await runMigrations({ pgPool: pool, logger: queueLogger(log) });
  } finally {
    await pool.end();
  }
}

export type WorkerGroup = {
  /** Tasks this group runs; a group only takes jobs it knows. */
  tasks: TaskList;
  concurrency: number;
  cron?: CronItem[];
};

/** Each task timed and traced (ADR 0018), under its own name. */
function measured(tasks: TaskList): TaskList {
  const list: TaskList = {};
  for (const [name, task] of Object.entries(tasks)) {
    if (!task) continue;
    list[name] = (payload, helpers) =>
      measureJob(name, async () => {
        await task(payload, helpers);
      });
  }
  return list;
}

/**
 * Starts one graphile-worker runner per group, on a pool of their own.
 * Separate groups keep long imports from holding up webhooks.
 */
export async function startQueue(options: {
  connectionString: string;
  groups: readonly WorkerGroup[];
  log: QueueLog;
}): Promise<{ stop: () => Promise<void> }> {
  const total = options.groups.reduce(
    (sum, group) => sum + group.concurrency,
    0,
  );
  // One connection per job, plus one to listen per runner.
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: total + options.groups.length + 2,
  });
  const failed = (error: Error) => {
    options.log.error({ err: error }, "queue connection failed");
  };
  pool.on("error", failed);
  // A connection the worker holds (to listen) reports its own errors.
  pool.on("connect", (client) => client.on("error", failed));
  const logger = queueLogger(options.log);
  const runners: Runner[] = [];
  try {
    for (const group of options.groups) {
      runners.push(
        await run({
          pgPool: pool,
          logger,
          // Each task timed and traced (ADR 0018).
          taskList: measured(group.tasks),
          concurrency: group.concurrency,
          noHandleSignals: true,
          parsedCronItems: parseCronItems(group.cron ?? []),
        }),
      );
    }
  } catch (error) {
    await Promise.allSettled(runners.map((runner) => runner.stop()));
    await pool.end();
    throw error;
  }
  return {
    stop: async () => {
      await Promise.allSettled(runners.map((runner) => runner.stop()));
      await pool.end();
    },
  };
}
