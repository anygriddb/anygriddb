/**
 * What each task does, and when the periodic ones run. A row event fans
 * out into one job per consumer, so each consumer retries on its own and
 * a slow webhook never delays an automation.
 */
import type { RowEvent } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import type { Task, TaskList } from "graphile-worker";
import type { Bus } from "../realtime/bus.js";
import { z } from "zod";
import {
  handleAutomationEvent,
  purgeRuns,
  runDueSchedules,
  runQueuedAutomation,
  type AutomationDeps,
} from "../automations.js";
import type { Env } from "../env.js";
import type { FileStore } from "../files/index.js";
import { jobRunners } from "../job-runners.js";
import {
  enqueueSystemJob,
  purgeJobs,
  recoverJobs,
  runQueuedJob,
  type QueueDeps,
} from "../jobs.js";
import {
  handleAssignments,
  notify,
  purgeNotifications,
  type NotificationInput,
  type NotifyDeps,
} from "../notifications.js";
import {
  handleWebhookEvent,
  purgeDeliveries,
  runDeliveryAttempt,
  sweepDeliveries,
  type HookDeps,
} from "../webhooks.js";
import {
  addJob,
  eventPayloadSchema,
  rowEventsPayloadSchema,
  TASKS,
} from "./jobs.js";
import { purgeAuthEvents } from "../auth/auth-events.js";
import { sweepInactiveAccounts } from "../auth/inactivity.js";
import { purgeResetLinks } from "../auth/password-reset.js";
import { readSettings } from "../settings.js";
import { purgeStagedUploads } from "../data/staged-uploads.js";
import { purgeLocks } from "../realtime/locks.js";
import { sweepOrphanFiles } from "../files/sweep.js";
import { settleExternalWrites } from "../sources/writes.js";
import { checkSeals, type SealDeps } from "../sources/statuses.js";
import { ensureWatches, queueWatch, runWatch } from "../sources/watch.js";
import {
  dropUnusedCopy,
  ensureSyncs,
  queueSync,
  runSync,
} from "../sources/sync.js";
import { announceRows } from "../data/announce.js";
import { runScheduledReleaseCheck } from "../release-status.js";
import { transactionEvents } from "./row-events.js";
import type { WorkerGroup } from "./worker.js";

export type TaskDeps = {
  db: Database;
  bus: Bus;
  env: Env;
  files: FileStore;
  log: (error: unknown, message: string) => void;
};

/** The jobs every row event becomes, one per consumer. */
const CONSUMERS = [
  TASKS.webhooksEvent,
  TASKS.assignmentsEvent,
  TASKS.automationsEvent,
] as const;

const deliveryPayloadSchema = z.object({ deliveryId: z.uuid() });
// A webhook call carries its body's values, and no row event.
const automationRunPayloadSchema = eventPayloadSchema.partial().extend({
  automationId: z.uuid(),
  values: z.record(z.string().max(63), z.string().max(10_000)).optional(),
});
const productJobPayloadSchema = z.object({ jobId: z.uuid() });
const watchPayloadSchema = z.object({ tableId: z.uuid() });
const sealsPayloadSchema = z.object({
  tableId: z.uuid().optional(),
  rowIds: z.array(z.string().min(1).max(1_000)).max(1_000).optional(),
});

/** Hands each event of a transaction to every consumer, in one commit. */
async function fanOut(db: Database, events: readonly RowEvent[]) {
  if (events.length === 0) return;
  await db.transaction().execute(async (tx) => {
    for (const event of events) {
      for (const task of CONSUMERS) {
        await addJob(tx, task, { event }, { maxAttempts: 5 });
      }
    }
  });
}

export function taskGroups(deps: TaskDeps): WorkerGroup[] {
  const notifyDeps: NotifyDeps = {
    db: deps.db,
    bus: deps.bus,
    smtp: deps.env,
    webOrigin: deps.env.PUBLIC_URL,
    log: deps.log,
  };
  const hookDeps: HookDeps = {
    db: deps.db,
    key: deps.env.AUTH_ENCRYPTION_KEY,
    smtp: deps.env,
    log: deps.log,
    notify: (items: NotificationInput[]) => notify(notifyDeps, items),
  };
  const automationDeps: AutomationDeps = {
    db: deps.db,
    bus: deps.bus,
    smtp: deps.env,
    webOrigin: deps.env.PUBLIC_URL,
    log: deps.log,
  };
  const sealDeps: SealDeps = {
    db: deps.db,
    log: deps.log,
    notify: (items) => notify(notifyDeps, items),
    announce: (tableId, rowIds) =>
      announceRows(
        { db: deps.db, bus: deps.bus, log: deps.log },
        tableId,
        "update",
        rowIds,
      ),
  };
  const queueDeps: QueueDeps = {
    db: deps.db,
    bus: deps.bus,
    log: deps.log,
  };
  const runners = jobRunners({
    db: deps.db,
    bus: deps.bus,
    files: deps.files,
    log: deps.log,
    key: deps.env.AUTH_ENCRYPTION_KEY,
    ...(deps.env.ATTACHMENT_MAX_BYTES
      ? { attachmentMaxBytes: deps.env.ATTACHMENT_MAX_BYTES }
      : {}),
  });

  const rowEvents: Task = async (payload) => {
    const parsed = rowEventsPayloadSchema.parse(payload);
    const events =
      "event" in parsed
        ? [parsed.event]
        : await transactionEvents(deps.db, parsed.xact, parsed.depth);
    await fanOut(deps.db, events);
  };
  const consumer =
    (handle: (event: RowEvent) => Promise<void>): Task =>
    async (payload) => {
      await handle(eventPayloadSchema.parse(payload).event);
    };

  const events: TaskList = {
    [TASKS.rowEvents]: rowEvents,
    [TASKS.webhooksEvent]: consumer((event) =>
      handleWebhookEvent(hookDeps, event),
    ),
    [TASKS.webhookAttempt]: async (payload) => {
      const { deliveryId } = deliveryPayloadSchema.parse(payload);
      await runDeliveryAttempt(hookDeps, deliveryId);
    },
    [TASKS.assignmentsEvent]: consumer((event) =>
      handleAssignments(notifyDeps, event),
    ),
    [TASKS.automationsEvent]: consumer((event) =>
      handleAutomationEvent(automationDeps, event),
    ),
    [TASKS.automationRun]: async (payload) => {
      const input = automationRunPayloadSchema.parse(payload);
      await runQueuedAutomation(automationDeps, input);
    },
    [TASKS.automationSchedules]: async () => {
      await runDueSchedules(automationDeps);
    },
    [TASKS.jobsRecover]: async () => {
      await recoverJobs(queueDeps);
    },
    [TASKS.webhookSweep]: async () => {
      await sweepDeliveries(deps.db);
    },
    [TASKS.purge]: async () => {
      await purgeDeliveries(deps.db);
      await purgeAuthEvents(
        deps.db,
        (await readSettings(deps.db)).authRetentionDays,
      );
      await purgeResetLinks(deps.db);
      await sweepInactiveAccounts({
        db: deps.db,
        env: deps.env,
        log: { error: (object, message) => deps.log(object, message) },
      });
      await purgeNotifications(deps.db);
      await purgeRuns(deps.db);
      await purgeJobs({ db: deps.db, files: deps.files, log: deps.log });
      await purgeLocks(deps.db);
      await purgeStagedUploads(deps.db, deps.files, (error) => {
        deps.log(error, "staged upload delete failed");
      });
    },
    [TASKS.fileSweep]: async () => {
      await sweepOrphanFiles(deps, {
        onError: (_key, error) => {
          deps.log(error, "orphan file delete failed");
        },
      });
    },
    [TASKS.externalSettle]: async () => {
      await settleExternalWrites(deps.db, deps.log);
    },
    [TASKS.externalWatch]: async (payload) => {
      const { tableId } = watchPayloadSchema.parse(payload);
      const next = await runWatch({ ...deps, seals: sealDeps }, tableId);
      // Each check queues the next one; the table's key keeps one queued.
      if (next !== null) await queueWatch(deps.db, tableId, next);
    },
    [TASKS.externalWatches]: async () => {
      await ensureWatches(deps.db);
    },
    [TASKS.externalSync]: async (payload) => {
      const { tableId } = watchPayloadSchema.parse(payload);
      const next = await runSync({ ...deps, seals: sealDeps }, tableId);
      if (next !== null) await queueSync(deps.db, tableId, next);
    },
    [TASKS.externalSyncs]: async () => {
      await ensureSyncs(deps.db);
    },
    [TASKS.externalSyncDrop]: async (payload) => {
      const { tableId } = watchPayloadSchema.parse(payload);
      await dropUnusedCopy(deps.db, tableId);
    },
    [TASKS.externalSeals]: async (payload) => {
      const { tableId, rowIds } = sealsPayloadSchema.parse(payload ?? {});
      await checkSeals(
        sealDeps,
        tableId && rowIds ? { tableId, rowIds } : undefined,
      );
    },
    [TASKS.trashPurge]: async () => {
      // The purge itself is a product job: it is logged like the others.
      await enqueueSystemJob(
        queueDeps,
        "trash_purge",
        { due: true },
        3_600_000,
      );
    },
    [TASKS.releaseCheck]: async () => {
      await runScheduledReleaseCheck(deps.db, { log: deps.log });
    },
  };
  const jobs: TaskList = {
    [TASKS.productJob]: async (payload, helpers) => {
      const { jobId } = productJobPayloadSchema.parse(payload);
      await runQueuedJob(queueDeps, jobId, runners, helpers.abortSignal);
    },
  };

  const once = { maxAttempts: 1, backfillPeriod: 0 };
  return [
    {
      tasks: events,
      concurrency: deps.env.WORKER_CONCURRENCY,
      cron: [
        {
          task: TASKS.automationSchedules,
          match: "* * * * *",
          options: once,
          identifier: "automation_schedules",
        },
        {
          task: TASKS.jobsRecover,
          match: "* * * * *",
          options: once,
          identifier: "jobs_recover",
        },
        {
          task: TASKS.webhookSweep,
          match: "*/10 * * * *",
          options: once,
          identifier: "webhook_sweep",
        },
        {
          task: TASKS.purge,
          match: "17 * * * *",
          options: once,
          identifier: "purge",
        },
        {
          // Writes to client tables a crash or a lost connection left open.
          task: TASKS.externalSettle,
          match: "* * * * *",
          options: once,
          identifier: "external_settle",
        },
        {
          // Changes made elsewhere in client tables: a check per table,
          // after a restart or a check that failed.
          task: TASKS.externalWatches,
          match: "* * * * *",
          options: once,
          identifier: "external_watches",
        },
        {
          // Synced client tables (ADR 0034): a refresh queued per table,
          // after a restart or a failure; orphaned copies dropped.
          task: TASKS.externalSyncs,
          match: "* * * * *",
          options: once,
          identifier: "external_syncs",
        },
        {
          // Sealed client rows compared with their fingerprint (ADR 0033).
          task: TASKS.externalSeals,
          match: "*/5 * * * *",
          options: once,
          identifier: "external_seals",
        },
        {
          task: TASKS.fileSweep,
          match: "45 4 * * *",
          options: once,
          identifier: "file_sweep",
        },
        {
          task: TASKS.trashPurge,
          match: "30 3 * * *",
          // A purge missed while the instance was down runs at start.
          options: { maxAttempts: 1, backfillPeriod: 86_400_000 },
          identifier: "trash_purge",
        },
        {
          // Opt-in GitHub release check (ADR 0048); no-op while off.
          task: TASKS.releaseCheck,
          match: "12 5 * * *",
          options: once,
          identifier: "release_check",
        },
      ],
    },
    { tasks: jobs, concurrency: deps.env.JOB_CONCURRENCY },
  ];
}
