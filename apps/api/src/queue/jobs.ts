/**
 * Background work runs on graphile-worker, in AnyGridDB's PostgreSQL
 * (ADR 0008). A job is added with SQL, so it can join the transaction of
 * the write that causes it: the job exists if and only if the write
 * committed.
 */
import { rowEventSchema, type RowEvent } from "@anygriddb/core";
import type { Executor } from "@anygriddb/db";
import { sql } from "kysely";
import { z } from "zod";

/** Every task the workers run, by identifier. */
export const TASKS = {
  /** The row events of one committed transaction. */
  rowEvents: "row_events",
  /** One row event for the webhooks of its table. */
  webhooksEvent: "webhooks_event",
  /** One attempt to deliver one webhook payload. */
  webhookAttempt: "webhook_attempt",
  /** One row event for people newly put in a user field. */
  assignmentsEvent: "assignments_event",
  /** One row event for the automations of its table. */
  automationsEvent: "automations_event",
  /** One run of one automation, at most once. */
  automationRun: "automation_run",
  /** One import, export, copy, or snapshot that a person follows. */
  productJob: "product_job",
  /** Periodic work, from the crontab. */
  automationSchedules: "automation_schedules",
  jobsRecover: "jobs_recover",
  webhookSweep: "webhook_sweep",
  purge: "purge",
  /** The alerts kept in step with what the instance finds. */
  alerts: "alerts",
  /** The change trail's events older than it is kept for. */
  auditPurge: "audit_purge",
  trashPurge: "trash_purge",
  fileSweep: "file_sweep",
  /** Reads rows of writes to client tables again, to settle them. */
  externalSettle: "external_settle",
  /** One check of one client table for changes made elsewhere. */
  externalWatch: "external_watch",
  /** Every watched client table has a check queued. */
  externalWatches: "external_watches",
  /** Compares sealed client rows with their fingerprint (ADR 0033). */
  externalSeals: "external_seals",
  /** One refresh of one synced client table (ADR 0034). */
  externalSync: "external_sync",
  /** Every synced client table has a refresh queued. */
  externalSyncs: "external_syncs",
  /** Drops the copy of a table read live again, once reads on it ended. */
  externalSyncDrop: "external_sync_drop",
  /** Opt-in check for a newer GitHub Release (ADR 0048). */
  releaseCheck: "release_check",
  /** One administrator notice to a frozen list of accounts (ADR 0052). */
  operatorMail: "operator_mail",
  /** One SIEM webhook delivery for an auth event (ADR 0056). */
  siemEvent: "siem_event",
  /** The first link of one account a file of people added, mailed. */
  accountWelcome: "account_welcome",
} as const;

export type TaskName = (typeof TASKS)[keyof typeof TASKS];

/** The database, or an open transaction the job joins. */
export type SqlExecutor = Executor;

export type AddJobOptions = {
  runAt?: Date;
  maxAttempts?: number;
  /** Replaces a queued job with the same key instead of adding a second. */
  jobKey?: string;
  jobKeyMode?: "replace" | "preserve_run_at" | "unsafe_dedupe";
};

export async function addJob(
  executor: SqlExecutor,
  task: TaskName,
  payload: unknown,
  options: AddJobOptions = {},
): Promise<void> {
  await sql`
    select graphile_worker.add_job(
      identifier => ${task}::text,
      payload => ${JSON.stringify(payload)}::json,
      run_at => ${options.runAt?.toISOString() ?? null}::timestamptz,
      max_attempts => ${options.maxAttempts ?? null}::integer,
      job_key => ${options.jobKey ?? null}::text,
      job_key_mode => ${options.jobKeyMode ?? "replace"}::text
    )
  `.execute(executor);
}

/**
 * Adds many jobs in one statement: they exist together, or not at all.
 * Nothing is added, and nothing is asked of the database, for an empty list.
 */
export async function addJobs(
  executor: SqlExecutor,
  jobs: ReadonlyArray<{
    task: TaskName;
    payload: unknown;
    maxAttempts?: number;
  }>,
): Promise<void> {
  if (jobs.length === 0) return;
  const specs = JSON.stringify(
    jobs.map((job) => ({
      identifier: job.task,
      payload: job.payload,
      max_attempts: job.maxAttempts ?? null,
    })),
  );
  await sql`
    select count(*) from graphile_worker.add_jobs(
      array(
        select json_populate_record(null::graphile_worker.job_spec, spec)
        from json_array_elements(${specs}::json) as spec
      )
    )
  `.execute(executor);
}

/**
 * The row events of a transaction come from its audit entries; an import
 * or another bulk write sends one event of its own instead.
 */
export const rowEventsPayloadSchema = z.union([
  z.object({
    xact: z.string().regex(/^\d{1,20}$/),
    depth: z.int().min(0).max(10).default(0),
  }),
  z.object({ event: rowEventSchema }),
]);

export type RowEventsPayload = z.infer<typeof rowEventsPayloadSchema>;

/**
 * Queues the row events of the current transaction. Call it inside the
 * write's transaction, after the writes; the task reads them once the
 * transaction committed.
 */
export async function queueTransactionEvents(
  executor: SqlExecutor,
  depth: number,
): Promise<void> {
  // One job per transaction, however many rows it wrote.
  await sql`
    select graphile_worker.add_job(
      identifier => ${TASKS.rowEvents}::text,
      payload => json_build_object(
        'xact', pg_current_xact_id()::text,
        'depth', ${depth}::integer
      ),
      max_attempts => 10,
      job_key => 'row_events:' || pg_current_xact_id()::text,
      job_key_mode => 'unsafe_dedupe'
    )
  `.execute(executor);
}

export const eventPayloadSchema = z.object({ event: rowEventSchema });

/**
 * One event that stands for many writes, such as an import. Each batch
 * replaces the queued event with its running total, in the batch's own
 * transaction, and the delay lets the next batch replace it again: the
 * event goes out once, with what committed.
 */
export type SummaryEvent = {
  event: RowEvent;
  /** Shared by every batch of the same operation. */
  key: string;
  delayMs: number;
};

export async function queueSummaryEvent(
  executor: SqlExecutor,
  summary: SummaryEvent,
): Promise<void> {
  await addJob(
    executor,
    TASKS.rowEvents,
    { event: { ...summary.event, at: new Date().toISOString() } },
    {
      runAt: new Date(Date.now() + summary.delayMs),
      maxAttempts: 10,
      jobKey: `summary:${summary.key}`,
      jobKeyMode: "replace",
    },
  );
}
