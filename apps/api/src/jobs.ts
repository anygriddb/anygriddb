import { actingUserId } from "./data/acting-context.js";
import { abandonConversion } from "./data/conversion-job.js";
import { readerRulesPrint } from "./data/acl.js";
import {
  accountExportJobInputSchema,
  AppError,
  type Binding,
  effectiveTableRole,
  JOB_HEARTBEAT_MS,
  JOB_LEASE_MS,
  jobInputSchemas,
  type JobKind,
  type JobStatus,
  limitIn,
  progressDue,
  type PublicError,
  publicError,
  roleFor,
} from "@anygriddb/core";
import { granted, runDeclared } from "./access/declaration.js";
import { JOB_ASKS } from "./job-runners.js";
import type { Database, JobRow } from "@anygriddb/db";
import type { KeyRing } from "./auth/key-ring.js";
import type { TokenScope } from "./auth/tokens.js";
import { sql as sqlTag } from "kysely";
import type { Bus } from "./realtime/bus.js";
import { gridChannel } from "./realtime/channels.js";
import { deleteFiles, type FileStore } from "./files/index.js";
import { notifyJobOutcome } from "./notify/dispatch.js";
import { addJob, TASKS, type SqlExecutor } from "./queue/jobs.js";
import { readGateSettings } from "./settings.js";

export type { JobRow };

type Publisher = {
  publish: (channel: string, message: string) => Promise<unknown>;
};

type Log = (error: unknown, message: string) => void;

/** Thrown by `progress` once the author cancelled, or the worker is stopping. */
export class JobCancelled extends AppError {
  constructor() {
    super("job_cancelled");
  }
}

type JobProgress = (done: number, total?: number | null) => Promise<void>;

type JobRun = {
  job: JobRow;
  /** Records progress; throws `JobCancelled` when the job should stop. */
  progress: JobProgress;
};

type JobOutcome = {
  result?: Record<string, unknown>;
  fileKey?: string;
};

export type JobRunner = (run: JobRun) => Promise<JobOutcome>;

const lease = () => new Date(Date.now() + JOB_LEASE_MS);

/** Tells the author's open tabs where a job stands. No data travels here. */
export async function publishJob(
  bus: Publisher,
  job: Pick<
    JobRow,
    "id" | "userId" | "kind" | "status" | "progressDone" | "progressTotal"
  >,
  log: Log,
): Promise<void> {
  if (!job.userId) return;
  try {
    await bus.publish(
      gridChannel(job.userId),
      JSON.stringify({
        type: "job",
        channel: job.userId,
        jobId: job.id,
        kind: job.kind,
        status: job.status,
        done: job.progressDone,
        total: job.progressTotal,
      }),
    );
  } catch (error) {
    log(error, "job publish failed");
  }
}

/* ------------------------------------------------------------------ */
/* Queue                                                               */
/* ------------------------------------------------------------------ */

export type QueueDeps = {
  db: Database;
  bus: Bus;
  log: Log;
  key?: KeyRing;
};

/**
 * Queued or running jobs one person may have at once, as Administration
 * sets it (ADR 0132).
 */
async function jobsAllowed(db: Database): Promise<number> {
  return limitIn(
    "jobs.active_per_account",
    (await readGateSettings(db)).limits,
  );
}

/** Refuses a job past those a person may have queued or running. */
async function countJobs(
  db: Database,
  userId: string,
  allowed: number,
): Promise<void> {
  const active = await db
    .selectFrom("jobs")
    .select(sqlTag<number>`count(*)::int`.as("value"))
    .where("userId", "=", userId)
    .where("status", "in", ["queued", "running"])
    .executeTakeFirst();
  if ((active?.value ?? 0) >= allowed) {
    throw new AppError("too_many_jobs");
  }
}

/** Refuses a job past those a person may have queued or running. */
export async function assertJobCapacity(
  db: Database,
  userId: string,
): Promise<void> {
  await countJobs(db, userId, await jobsAllowed(db));
}

/**
 * The same inside the transaction that adds the job, one at a time for a
 * person: two requests at once would both count before either has written.
 */
async function holdJobCapacity(
  tx: Database,
  userId: string,
  allowed: number,
): Promise<void> {
  await sqlTag`select pg_advisory_xact_lock(hashtext(${`jobs:${userId}`}))`.execute(
    tx,
  );
  await countJobs(tx, userId, allowed);
}

/**
 * Queues a job for its author. The input is checked against the kind's
 * schema here, and the runner checks the author's rights again when it
 * starts, since they may change in between.
 */
export async function enqueueJob(
  deps: QueueDeps,
  input: {
    kind: JobKind;
    userId: string;
    baseId?: string;
    tableId?: string;
    input: unknown;
  },
): Promise<JobRow> {
  // A job runs later, with its author's rights: those of the administrator,
  // not of the person they act as (ADR 0109).
  if (actingUserId()) throw new AppError("acting_no_job");
  const parsed = jobInputSchemas[input.kind].safeParse(input.input);
  if (!parsed.success) {
    throw new AppError("invalid_job");
  }
  const allowed = await jobsAllowed(deps.db);
  const job = await deps.db.transaction().execute(async (tx) => {
    await holdJobCapacity(tx, input.userId, allowed);
    const row = await tx
      .insertInto("jobs")
      .values({
        kind: input.kind,
        userId: input.userId,
        baseId: input.baseId ?? null,
        tableId: input.tableId ?? null,
        input: parsed.data,
      })
      .returningAll()
      .executeTakeFirst();
    if (!row) throw new AppError("no_row");
    await queueProductJob(tx, row.id);
    return row;
  });
  await publishJob(deps.bus, job, deps.log);
  return job;
}

/**
 * Queues a job that runs without an author, such as the trash purge,
 * unless one of the same kind was queued within `everyMs`.
 */
export async function enqueueSystemJob(
  deps: QueueDeps,
  kind: JobKind,
  input: unknown,
  everyMs: number,
): Promise<JobRow | undefined> {
  const parsed = jobInputSchemas[kind].safeParse(input);
  if (!parsed.success) throw new AppError("invalid_job");
  const recent = await deps.db
    .selectFrom("jobs")
    .select("id")
    .where("kind", "=", kind)
    .where("userId", "is", null)
    .where("createdAt", ">", new Date(Date.now() - everyMs))
    .executeTakeFirst();
  if (recent) return undefined;
  return deps.db.transaction().execute(async (tx) => {
    const job = await tx
      .insertInto("jobs")
      .values({ kind, userId: null, input: parsed.data })
      .returningAll()
      .executeTakeFirst();
    if (job) await queueProductJob(tx, job.id);
    return job;
  });
}

/**
 * Runs a product job in graphile-worker, at most once: its runner writes
 * rows and files, and a person decides whether to start it again. Each
 * retry takes a key of its own: the queue keeps the entry of a run whose
 * worker died, and would take a second one under that key for the first.
 */
function queueProductJob(executor: SqlExecutor, jobId: string, run = 0) {
  return addJob(
    executor,
    TASKS.productJob,
    { jobId },
    {
      maxAttempts: 1,
      jobKey: run === 0 ? `job:${jobId}` : `job:${jobId}:${String(run)}`,
      jobKeyMode: "unsafe_dedupe",
    },
  );
}

/** Starts a queued job and its lease; undefined once it was cancelled. */
export async function claimJob(
  db: Database,
  jobId: string,
): Promise<JobRow | undefined> {
  return db
    .updateTable("jobs")
    .set((eb) => ({
      status: "running",
      attempts: eb("attempts", "+", 1),
      startedAt: new Date(),
      leaseUntil: lease(),
    }))
    .where("id", "=", jobId)
    .where("status", "=", "queued")
    .returningAll()
    .executeTakeFirst();
}

/** The task behind every product job: claims it, then runs it to its end. */
export async function runQueuedJob(
  deps: QueueDeps,
  jobId: string,
  runners: Partial<Record<JobKind, JobRunner>>,
  stopping: AbortSignal,
): Promise<void> {
  const job = await claimJob(deps.db, jobId);
  if (!job) return;
  await runDeclared(
    `job.${job.kind}`,
    JOB_ASKS[job.kind],
    () => runJob(deps, job, runners[job.kind], stopping),
    (message) => deps.log(new Error(message), "undeclared permission"),
  );
}

/** How long an export file can be downloaded, as Administration sets it. */
async function fileHours(db: Database): Promise<number> {
  return limitIn("export.file_hours", (await readGateSettings(db)).limits);
}

async function finishJob(
  db: Database,
  id: string,
  patch: {
    status: Extract<JobStatus, "done" | "failed" | "cancelled">;
    result?: Record<string, unknown> | null;
    error?: PublicError | null;
    fileKey?: string | null;
    progressDone?: number;
  },
): Promise<JobRow | undefined> {
  return db
    .updateTable("jobs")
    .set({
      status: patch.status,
      result: patch.result ?? null,
      error: patch.error?.message ?? null,
      errorCode: patch.error?.code ?? null,
      errorDetail: patch.error?.detail ?? null,
      fileKey: patch.fileKey ?? null,
      fileExpiresAt: patch.fileKey
        ? new Date(Date.now() + (await fileHours(db)) * 3_600_000)
        : null,
      finishedAt: new Date(),
      leaseUntil: null,
      ...(patch.progressDone === undefined
        ? {}
        : { progressDone: patch.progressDone }),
    })
    .where("id", "=", id)
    .where("status", "=", "running")
    .returningAll()
    .executeTakeFirst();
}

/**
 * A job that failed with part of its work already kept: the failure, and
 * what its author is told was done.
 */
export class JobStoppedAfter extends Error {
  constructor(
    readonly failure: unknown,
    readonly result: Record<string, unknown>,
  ) {
    super("Job stopped");
  }
}

/** A failure as its author may read it: a stable code, never internals. */
export function jobError(error: unknown): PublicError {
  return publicError(error);
}

const INTERRUPTED = publicError(new AppError("interrupted"));

/**
 * Runs one claimed job to its end. The lease is renewed on a timer and
 * with every progress write, which also reads the cancel flag.
 */
export async function runJob(
  deps: QueueDeps,
  job: JobRow,
  runner: JobRunner | undefined,
  stopping: AbortSignal,
): Promise<JobRow | undefined> {
  let last: number | undefined;
  let done = job.progressDone;
  let total = job.progressTotal;
  let cancelled = false;
  // Read through a call: the heartbeat sets `cancelled` while the job awaits.
  const isCancelled = (): boolean => cancelled;
  const renew = async () => {
    const row = await deps.db
      .updateTable("jobs")
      .set({ leaseUntil: lease(), progressDone: done, progressTotal: total })
      .where("id", "=", job.id)
      .where("status", "=", "running")
      .returning("cancelRequested as cancel")
      .executeTakeFirst();
    if (row?.cancel) cancelled = true;
  };
  const heartbeat = setInterval(() => {
    renew().catch((error: unknown) => deps.log(error, "job heartbeat failed"));
  }, JOB_HEARTBEAT_MS);
  heartbeat.unref();
  const progress: JobProgress = async (nextDone, nextTotal) => {
    done = nextDone;
    if (nextTotal !== undefined) total = nextTotal;
    if (isCancelled() || stopping.aborted) throw new JobCancelled();
    const now = Date.now();
    if (!progressDue(last, now, done, total)) return;
    last = now;
    await renew();
    await publishJob(
      deps.bus,
      { ...job, progressDone: done, progressTotal: total },
      deps.log,
    );
    if (isCancelled()) throw new JobCancelled();
  };
  let finished: JobRow | undefined;
  try {
    if (!runner) throw new AppError("invalid_job");
    const outcome = await runner({ job, progress });
    finished = await finishJob(deps.db, job.id, {
      status: "done",
      result: outcome.result ?? null,
      fileKey: outcome.fileKey ?? null,
      progressDone: total ?? done,
    });
  } catch (error) {
    if (error instanceof JobCancelled) {
      finished = await finishJob(deps.db, job.id, {
        status: isCancelled() ? "cancelled" : "failed",
        error: isCancelled() ? null : INTERRUPTED,
        progressDone: done,
      });
    } else {
      const stopped = error instanceof JobStoppedAfter ? error : undefined;
      const cause = stopped ? stopped.failure : error;
      const failure = jobError(cause);
      if (failure.code === "internal_error") deps.log(cause, "job failed");
      finished = await finishJob(deps.db, job.id, {
        status: "failed",
        error: failure,
        result: stopped?.result ?? null,
        progressDone: done,
      });
    }
  } finally {
    clearInterval(heartbeat);
  }
  if (finished) {
    await publishJob(deps.bus, finished, deps.log);
    if (finished.status === "failed" || finished.status === "done") {
      await notifyJobOutcome(
        deps.db,
        deps.log,
        {
          id: finished.id,
          kind: finished.kind,
          status: finished.status,
          errorCode: finished.errorCode,
        },
        deps.key,
      );
    }
  }
  return finished;
}

/** Fails running jobs whose worker stopped renewing their lease. */
export async function recoverJobs(deps: QueueDeps): Promise<number> {
  const lapsed = await deps.db
    .updateTable("jobs")
    .set({
      status: "failed",
      error: INTERRUPTED.message,
      errorCode: INTERRUPTED.code,
      finishedAt: new Date(),
      leaseUntil: null,
    })
    .where("status", "=", "running")
    .where("leaseUntil", "<", new Date())
    .returningAll()
    .execute();
  for (const job of lapsed) {
    // Its table is read-only for no one now: what it had begun goes away.
    if (job.kind === "convert_column") {
      await abandonConversion(deps.db, job).catch((error: unknown) =>
        deps.log(error, "conversion cleanup failed"),
      );
    }
    await publishJob(deps.bus, job, deps.log);
    await notifyJobOutcome(
      deps.db,
      deps.log,
      {
        id: job.id,
        kind: job.kind,
        status: "failed",
        errorCode: job.errorCode,
      },
      deps.key,
    );
  }
  return lapsed.length;
}

/** Deletes expired export files, then jobs finished over a week ago. */
export async function purgeJobs(deps: {
  db: Database;
  files: FileStore;
  log: Log;
}): Promise<void> {
  const onError = (error: unknown) =>
    deps.log(error, "export file delete failed");
  const expired = await deps.db
    .selectFrom("jobs")
    .select(["id", "fileKey as key"])
    .where("fileKey", "is not", null)
    .where("fileExpiresAt", "<", new Date())
    .limit(500)
    .execute();
  if (expired.length > 0) {
    await deleteFiles(
      deps.files,
      expired.flatMap((row) => (row.key ? [row.key] : [])),
      onError,
    );
    await deps.db
      .updateTable("jobs")
      .set({ fileKey: null })
      .where(
        "id",
        "in",
        expired.map((row) => row.id),
      )
      .execute();
  }
  const days = limitIn(
    "jobs.retention_days",
    (await readGateSettings(deps.db)).limits,
  );
  const cutoff = new Date(Date.now() - days * 86_400_000);
  const old = await deps.db
    .deleteFrom("jobs")
    .where("createdAt", "<", cutoff)
    .where("status", "in", ["done", "failed", "cancelled"])
    .returning("fileKey as key")
    .execute();
  await deleteFiles(
    deps.files,
    old.flatMap((row) => (row.key ? [row.key] : [])),
    onError,
  );
}

/* ------------------------------------------------------------------ */
/* Reading and cancelling                                              */
/* ------------------------------------------------------------------ */

/** A job's result as its author reads it: the print of their rules stays here. */
function shownResult(result: JobRow["result"]): JobRow["result"] {
  if (!result || !("rulesPrint" in result)) return result ?? null;
  return Object.fromEntries(
    Object.entries(result).filter(([key]) => key !== "rulesPrint"),
  );
}

/** A finished job whose file is still kept. */
function fileInDate(job: JobRow): boolean {
  return Boolean(
    job.status === "done" &&
    job.fileKey &&
    job.fileExpiresAt &&
    job.fileExpiresAt.getTime() > Date.now(),
  );
}

/**
 * A job as its author reads it. `fileReadable` is whether they may still
 * have the file today (the same check as `GET /api/jobs/:id/file`): a
 * finished export still in date is not offered once their rights no longer
 * match what wrote it.
 */
export function publicJob(
  job: JobRow & { tableName?: string | null },
  options?: { fileReadable?: boolean },
) {
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    done: job.progressDone,
    total: job.progressTotal,
    error: job.error,
    // What the app translates; null for a job from before codes, or none.
    reason: job.errorCode
      ? { code: job.errorCode, detail: job.errorDetail ?? undefined }
      : null,
    result: shownResult(job.result),
    baseId: job.baseId,
    tableId: job.tableId,
    tableName: job.tableName ?? null,
    download: fileInDate(job) && Boolean(options?.fileReadable),
    retryable: jobCanRetry(job),
    createdAt: job.createdAt.toISOString(),
    finishedAt: job.finishedAt?.toISOString() ?? null,
  };
}

type PublicJob = ReturnType<typeof publicJob>;

type JobReader = {
  user: { id: string; isAdmin: boolean };
  bindings: readonly Binding[];
};

/** A job with its download flag set from the reader's rights today. */
export async function presentJob(
  db: Database,
  job: JobRow & { tableName?: string | null },
  reader: JobReader,
): Promise<PublicJob> {
  if (!fileInDate(job)) return publicJob(job);
  return publicJob(job, {
    fileReadable: await jobFileReadableBy(db, job, reader),
  });
}

/** A person's jobs, with the name of the table each one is about. */
function jobsWithTable(db: Database) {
  return db
    .selectFrom("jobs")
    .leftJoin("dataTables", "dataTables.id", "jobs.tableId")
    .selectAll("jobs")
    .select("dataTables.name as tableName");
}

export async function listJobs(
  db: Database,
  reader: JobReader,
  limit: number,
  scope?: TokenScope,
): Promise<PublicJob[]> {
  if (scope?.baseIds?.length === 0) return [];
  const rows = await jobsWithTable(db)
    .where("jobs.userId", "=", reader.user.id)
    .$if(scope !== undefined, (query) =>
      query.where("jobs.baseId", "is not", null),
    )
    .$if(Boolean(scope?.baseIds), (query) =>
      query.where("jobs.baseId", "in", scope?.baseIds ?? []),
    )
    .orderBy("jobs.createdAt", "desc")
    .limit(limit)
    .execute();
  return Promise.all(rows.map((row) => presentJob(db, row, reader)));
}

/**
 * Whether a token reaches a job. A job of no base is an account's export,
 * which an administrator may have asked for someone else: no token does.
 */
function jobInScope(job: Pick<JobRow, "baseId">, scope: TokenScope): boolean {
  if (job.baseId === null) return false;
  return scope.baseIds === null || scope.baseIds.includes(job.baseId);
}

/**
 * One of the caller's jobs; someone else's reads as unknown, and so does
 * one the token it is asked with does not reach.
 */
export async function loadOwnJob(
  db: Database,
  userId: string,
  jobId: string,
  scope?: TokenScope,
): Promise<JobRow & { tableName: string | null }> {
  const row = await jobsWithTable(db)
    .where("jobs.id", "=", jobId)
    .where("jobs.userId", "=", userId)
    .executeTakeFirst();
  if (!row || (scope && !jobInScope(row, scope))) {
    throw new AppError("unknown_job");
  }
  return row;
}

/**
 * Whether its author may still have a job's file: the right that made it,
 * as it stands today. A person removed from a base does not keep what an
 * export of it wrote, and an administrator who no longer is does not keep
 * someone else's account. A base since deleted leaves no right to read.
 */
export function jobReadableBy(
  job: Pick<JobRow, "kind" | "baseId" | "tableId" | "input">,
  reader: { id: string; isAdmin: boolean },
  bindings: readonly Binding[],
): boolean {
  if (job.kind === "account_export") {
    return (
      reader.isAdmin ||
      accountExportJobInputSchema.safeParse(job.input).data?.userId ===
        reader.id
    );
  }
  if (job.baseId === null) return false;
  if (job.kind === "export_snapshot") {
    const role = roleFor(bindings, "base", job.baseId);
    return granted(role, "base.manage") && granted(role, "data.export");
  }
  return granted(
    job.tableId
      ? effectiveTableRole(bindings, job.tableId, job.baseId)
      : roleFor(bindings, "base", job.baseId),
    "data.export",
  );
}

/**
 * The same, and a table's export is served only under the field and row
 * rules it was written under: a file cannot be filtered again once written.
 * A file from before the print was kept counts as written under no rule.
 */
export async function jobFileReadableBy(
  db: Database,
  job: Pick<JobRow, "kind" | "baseId" | "tableId" | "input" | "result">,
  actor: {
    user: { id: string; isAdmin: boolean };
    bindings: readonly Binding[];
  },
): Promise<boolean> {
  if (!jobReadableBy(job, actor.user, actor.bindings)) return false;
  if (job.kind !== "export") return true;
  const written = job.result?.rulesPrint;
  const today = job.tableId
    ? await readerRulesPrint(
        db,
        { userId: actor.user.id, bindings: actor.bindings },
        job.tableId,
      )
    : null;
  return (typeof written === "string" ? written : null) === today;
}

/**
 * Kinds whose run is safe to start again from nothing: an export rewrites
 * its file, a restore point keeps its file only once its line is written,
 * a copy or a restore removes the table or base it had begun when it fails
 * or is stopped, and a conversion leaves its field as it was until its
 * last step. An import is not one of them: the rows it wrote before
 * failing would be written twice.
 */
const RETRYABLE_KINDS: ReadonlySet<JobKind> = new Set([
  "export",
  "export_snapshot",
  "duplicate_table",
  "duplicate_base",
  "restore_point",
  "restore_base",
  "convert_column",
]);

/** Of the kinds started again, those that make a new base. */
const BASE_MAKING_KINDS: ReadonlySet<JobKind> = new Set([
  "duplicate_base",
  "restore_base",
]);

export function jobMakesBase(job: Pick<JobRow, "kind">): boolean {
  return BASE_MAKING_KINDS.has(job.kind);
}

/** Whether its author may put this job back on the queue. */
export function jobCanRetry(job: Pick<JobRow, "kind" | "status">): boolean {
  return job.status === "failed" && RETRYABLE_KINDS.has(job.kind);
}

/**
 * Puts a failed or interrupted job back on the queue, as it was asked.
 * The runner checks its author's rights again when it starts. A
 * cancelled job is not retried: its author chose to stop it.
 */
export async function retryJob(
  deps: QueueDeps,
  userId: string,
  jobId: string,
): Promise<JobRow> {
  const job = await loadOwnJob(deps.db, userId, jobId);
  if (!jobCanRetry(job)) {
    throw new AppError("job_not_retryable");
  }
  const allowed = await jobsAllowed(deps.db);
  const queued = await deps.db.transaction().execute(async (tx) => {
    await holdJobCapacity(tx, userId, allowed);
    const row = await tx
      .updateTable("jobs")
      .set({
        status: "queued",
        error: null,
        errorCode: null,
        errorDetail: null,
        result: null,
        startedAt: null,
        finishedAt: null,
        leaseUntil: null,
        cancelRequested: false,
        progressDone: 0,
        progressTotal: null,
      })
      .where("id", "=", job.id)
      .where("status", "=", "failed")
      .returningAll()
      .executeTakeFirst();
    // Asked twice at once: the first one queued it.
    if (!row) throw new AppError("job_not_retryable");
    await queueProductJob(tx, row.id, row.attempts);
    return row;
  });
  await publishJob(deps.bus, queued, deps.log);
  return queued;
}

/** A queued job stops at once; a running one at its next progress report. */
export async function cancelJob(
  deps: QueueDeps,
  userId: string,
  jobId: string,
): Promise<void> {
  await cancelJobWhere(deps, jobId, userId);
}

/** The same, for an administrator: any person's job (ADR 0042). */
export async function cancelAnyJob(
  deps: QueueDeps,
  jobId: string,
): Promise<void> {
  await cancelJobWhere(deps, jobId, null);
}

async function cancelJobWhere(
  deps: QueueDeps,
  jobId: string,
  ownerId: string | null,
): Promise<void> {
  const queued = await deps.db
    .updateTable("jobs")
    // A sealed token a job carries (Airtable) goes with the job that will
    // not run.
    .set({
      status: "cancelled",
      finishedAt: new Date(),
      input: sqlTag`input - 'token'`,
    })
    .where("id", "=", jobId)
    .$if(ownerId !== null, (query) => query.where("userId", "=", ownerId ?? ""))
    .where("status", "=", "queued")
    .returningAll()
    .executeTakeFirst();
  if (queued) {
    await publishJob(deps.bus, queued, deps.log);
    return;
  }
  const running = await deps.db
    .updateTable("jobs")
    .set({ cancelRequested: true })
    .where("id", "=", jobId)
    .$if(ownerId !== null, (query) => query.where("userId", "=", ownerId ?? ""))
    .where("status", "=", "running")
    .returning("id")
    .executeTakeFirst();
  if (!running) throw new AppError("unknown_job");
}

/** Every person's jobs, newest first, for the administration. */
export async function listAllJobs(
  db: Database,
  input: { status?: JobRow["status"]; limit: number; offset?: number },
): Promise<{
  jobs: Array<PublicJob & { userName: string | null }>;
  total: number;
}> {
  const offset = input.offset ?? 0;
  const counted = await db
    .selectFrom("jobs")
    .select((eb) => eb.fn.countAll<string>().as("value"))
    .$if(input.status !== undefined, (query) =>
      query.where("status", "=", input.status ?? "queued"),
    )
    .executeTakeFirst();
  const total = Number(counted?.value ?? 0);
  const rows = await jobsWithTable(db)
    .leftJoin("users", "users.id", "jobs.userId")
    .select("users.displayName as userName")
    .$if(input.status !== undefined, (query) =>
      query.where("jobs.status", "=", input.status ?? "queued"),
    )
    .orderBy("jobs.createdAt", "desc")
    .offset(offset)
    .limit(input.limit)
    .execute();
  return {
    total,
    jobs: rows.map((row) => ({ ...publicJob(row), userName: row.userName })),
  };
}
