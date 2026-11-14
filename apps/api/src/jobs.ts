import {
  AppError,
  EXPORT_FILE_HOURS,
  JOB_HEARTBEAT_MS,
  JOB_LEASE_MS,
  JOB_RETENTION_DAYS,
  jobInputSchemas,
  type JobKind,
  type JobStatus,
  MAX_ACTIVE_JOBS,
  progressDue,
  type PublicError,
  publicError,
} from "@anygriddb/core";
import type { Database, JobRow } from "@anygriddb/db";
import { sql as sqlTag } from "kysely";
import type { Bus } from "./realtime/bus.js";
import { gridChannel } from "./realtime/channels.js";
import { deleteFiles, type FileStore } from "./files/index.js";
import { addJob, TASKS, type SqlExecutor } from "./queue/jobs.js";

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

export type QueueDeps = { db: Database; bus: Bus; log: Log };

/** Refuses a sixth queued or running job for the same person. */
export async function assertJobCapacity(
  db: Database,
  userId: string,
): Promise<void> {
  const active = await db
    .selectFrom("jobs")
    .select(sqlTag<number>`count(*)::int`.as("value"))
    .where("userId", "=", userId)
    .where("status", "in", ["queued", "running"])
    .executeTakeFirst();
  if ((active?.value ?? 0) >= MAX_ACTIVE_JOBS) {
    throw new AppError("too_many_jobs");
  }
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
  const parsed = jobInputSchemas[input.kind].safeParse(input.input);
  if (!parsed.success) {
    throw new AppError("invalid_job");
  }
  await assertJobCapacity(deps.db, input.userId);
  const job = await deps.db.transaction().execute(async (tx) => {
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
  await runJob(deps, job, runners[job.kind], stopping);
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
        ? new Date(Date.now() + EXPORT_FILE_HOURS * 3_600_000)
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
      const failure = jobError(error);
      if (failure.code === "internal_error") deps.log(error, "job failed");
      finished = await finishJob(deps.db, job.id, {
        status: "failed",
        error: failure,
        progressDone: done,
      });
    }
  } finally {
    clearInterval(heartbeat);
  }
  if (finished) await publishJob(deps.bus, finished, deps.log);
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
  for (const job of lapsed) await publishJob(deps.bus, job, deps.log);
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
  const cutoff = new Date(Date.now() - JOB_RETENTION_DAYS * 86_400_000);
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

export function publicJob(job: JobRow & { tableName?: string | null }) {
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
    result: job.result ?? null,
    baseId: job.baseId,
    tableId: job.tableId,
    tableName: job.tableName ?? null,
    download: Boolean(
      job.status === "done" &&
      job.fileKey &&
      job.fileExpiresAt &&
      job.fileExpiresAt.getTime() > Date.now(),
    ),
    retryable: jobCanRetry(job),
    createdAt: job.createdAt.toISOString(),
    finishedAt: job.finishedAt?.toISOString() ?? null,
  };
}

type PublicJob = ReturnType<typeof publicJob>;

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
  userId: string,
  limit: number,
): Promise<PublicJob[]> {
  const rows = await jobsWithTable(db)
    .where("jobs.userId", "=", userId)
    .orderBy("jobs.createdAt", "desc")
    .limit(limit)
    .execute();
  return rows.map((row) => publicJob(row));
}

/** One of the caller's jobs; someone else's reads as unknown. */
export async function loadOwnJob(
  db: Database,
  userId: string,
  jobId: string,
): Promise<JobRow & { tableName: string | null }> {
  const row = await jobsWithTable(db)
    .where("jobs.id", "=", jobId)
    .where("jobs.userId", "=", userId)
    .executeTakeFirst();
  if (!row) throw new AppError("unknown_job");
  return row;
}

/**
 * Kinds whose run is safe to start again from nothing: an export rewrites
 * its file, and a copy removes the table or base it had begun when it
 * fails or is stopped. An import is not one of them: the rows it wrote
 * before failing would be written twice.
 */
const RETRYABLE_KINDS: ReadonlySet<JobKind> = new Set([
  "export",
  "export_snapshot",
  "duplicate_table",
  "duplicate_base",
]);

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
  await assertJobCapacity(deps.db, userId);
  const queued = await deps.db.transaction().execute(async (tx) => {
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
  input: { status?: JobRow["status"]; limit: number },
): Promise<Array<PublicJob & { userName: string | null }>> {
  const rows = await jobsWithTable(db)
    .leftJoin("users", "users.id", "jobs.userId")
    .select("users.displayName as userName")
    .$if(input.status !== undefined, (query) =>
      query.where("jobs.status", "=", input.status ?? "queued"),
    )
    .orderBy("jobs.createdAt", "desc")
    .limit(input.limit)
    .execute();
  return rows.map((row) => ({ ...publicJob(row), userName: row.userName }));
}
