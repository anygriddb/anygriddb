import { loggedFields, quietError } from "../logged-error.js";
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

type QueueLog = {
  error: (meta: Record<string, unknown>, message: string) => void;
  warn: (meta: Record<string, unknown>, message: string) => void;
  info: (meta: Record<string, unknown>, message: string) => void;
  debug: (meta: Record<string, unknown>, message: string) => void;
};

/** graphile-worker's logs, in the API's structured log. */
function queueLogger(log: QueueLog): Logger {
  const factory: LogFunctionFactory = (scope) => (level, message, meta) => {
    // The queue's own fields hold the job, payload included, and the
    // error as it was thrown: a log line keeps neither.
    const fields = { queue: scope, ...loggedFields(meta) };
    if (level === "error") log.error(fields, message);
    else if (level === "warning") log.warn(fields, message);
    else if (level === "info") log.info(fields, message);
    else log.debug(fields, message);
  };
  return new Logger(factory);
}

/**
 * The first table of graphile-worker's schema, as the library makes it in
 * a new database: its own three statements, each of which changes nothing
 * where it has run. One transaction, behind a lock of its own: two
 * instances started on the same new database make it one after the other.
 */
const QUEUE_FIRST_TABLE = `
select pg_advisory_xact_lock(hashtext('ag_queue_install'));
create schema if not exists graphile_worker;
create table if not exists graphile_worker.migrations(
  id int primary key,
  ts timestamptz default now() not null
);
alter table graphile_worker.migrations add column if not exists breaking boolean not null default false;
`;

/**
 * Creates or upgrades graphile-worker's schema. It needs no extension and
 * no superuser: only the right to create a schema in the database.
 *
 * The library learns that a database is new by asking its first table and
 * being refused, and PostgreSQL writes a refused statement in its log as
 * an error: one at every new install, for an operator to wonder about.
 * The table is made here first, when it is not there, and the library
 * then finds it empty and installs everything else.
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
    const { rows } = await pool.query<{ there: boolean }>(
      "select to_regclass('graphile_worker.migrations') is not null as there",
    );
    if (rows[0]?.there !== true) await pool.query(QUEUE_FIRST_TABLE);
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
        try {
          await task(payload, helpers);
        } catch (error) {
          // The queue writes a failed task's message into its log line
          // and its `last_error`: it gets the failure without its words.
          throw quietError(error);
        }
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
  // One connection per job, plus one to listen per runner. The same
  // statement and lock ceilings as the request pool (packages/db client).
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: total + options.groups.length + 2,
    application_name: "anygriddb-worker",
    options: "-c idle_in_transaction_session_timeout=60s",
    statement_timeout: 60_000,
    lock_timeout: 15_000,
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
