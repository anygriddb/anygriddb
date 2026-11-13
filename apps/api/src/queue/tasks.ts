/**
 * What each task does, and when the periodic ones run. A row event fans
 * out into one job per consumer, so each consumer retries on its own and
 * a slow webhook never delays an automation.
 */
import { checkAlerts } from "../alerts.js";
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
  assignmentNotifies,
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
  addJobs,
  eventPayloadSchema,
  rowEventsPayloadSchema,
  TASKS,
  type TaskName,
} from "./jobs.js";
import { purgeAuthEvents } from "../auth/auth-events.js";
import { purgeExpiredSignIns } from "../auth/expired.js";
import { sweepInactiveAccounts } from "../auth/inactivity.js";
import { purgeResetLinks } from "../auth/password-reset.js";
import { purgeSignupRequests } from "../auth/signup-requests.js";
import { readSettings } from "../settings.js";
import { purgeStagedUploads } from "../data/staged-uploads.js";
import { purgeStagedAttachments } from "../data/staged-attachments.js";
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
import { liveColumn } from "../data/live.js";
import { resolveSmtp } from "../integrations/smtp.js";
import {
  deliverOperatorMail,
  operatorMailPayloadSchema,
} from "../operator-mail.js";
import { deliverSiemEvent } from "../integrations/siem.js";
import { runScheduledReleaseCheck } from "../release-status.js";
import { transactionEvents } from "./row-events.js";
import type { WorkerGroup } from "./worker.js";

export type TaskDeps = {
  db: Database;
  bus: Bus;
  env: Env;
  files: FileStore;
  log: (error: unknown, message: string) => void;
  /** When the certificate people are served expires; none without TLS. */
  certificateExpires?: () => string | null;
};

/** Who takes the row events of a table: only those with work to do. */
type Consumers = {
  webhooks: boolean;
  assignments: boolean;
  automations: boolean;
};

/**
 * Which consumers the tables of some events have: an active webhook, a
 * user field that notifies, an automation switched on. Most tables have
 * none, and their writes then queue nothing more.
 */
async function consumersOf(
  db: Database,
  tableIds: readonly string[],
): Promise<Map<string, Consumers>> {
  const [hooks, people, automations] = await Promise.all([
    db
      .selectFrom("webhooks")
      .select("tableId")
      .distinct()
      .where("tableId", "in", tableIds)
      .where("active", "=", true)
      .execute(),
    db
      .selectFrom("dataColumns")
      .select(["tableId", "config"])
      .where("tableId", "in", tableIds)
      .where("fieldType", "=", "user")
      .where(liveColumn())
      .execute(),
    db
      .selectFrom("automations")
      .select("tableId")
      .distinct()
      .where("tableId", "in", tableIds)
      .where("enabled", "=", true)
      .execute(),
  ]);
  const withHooks = new Set(hooks.map((row) => row.tableId));
  const withPeople = new Set(
    people
      .filter((column) => assignmentNotifies(column.config))
      .map((column) => column.tableId),
  );
  const withAutomations = new Set(automations.map((row) => row.tableId));
  return new Map(
    tableIds.map((id) => [
      id,
      {
        webhooks: withHooks.has(id),
        assignments: withPeople.has(id),
        automations: withAutomations.has(id),
      },
    ]),
  );
}

/** The consumer jobs one event becomes, given who listens to its table. */
export function consumerTasks(
  event: RowEvent,
  consumers: Consumers | undefined,
): TaskName[] {
  if (!consumers) return [];
  const tasks: TaskName[] = [];
  if (consumers.webhooks) tasks.push(TASKS.webhooksEvent);
  // People are told of a row they were put on; automations run on a row.
  if (
    consumers.assignments &&
    event.rowId &&
    (event.event === "insert" || event.event === "update")
  ) {
    tasks.push(TASKS.assignmentsEvent);
  }
  if (consumers.automations && event.rowId) {
    tasks.push(TASKS.automationsEvent);
  }
  return tasks;
}

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

/**
 * Hands each event of a transaction to the consumers of its table, in one
 * statement: every job exists, or none does.
 */
async function fanOut(db: Database, events: readonly RowEvent[]) {
  if (events.length === 0) return;
  const consumers = await consumersOf(db, [
    ...new Set(events.map((event) => event.tableId)),
  ]);
  await addJobs(
    db,
    events.flatMap((event) =>
      consumerTasks(event, consumers.get(event.tableId)).map((task) => ({
        task,
        payload: { event },
        maxAttempts: 5,
      })),
    ),
  );
}

export function taskGroups(deps: TaskDeps): WorkerGroup[] {
  async function mailSmtp() {
    return (await resolveSmtp(deps.db, deps.env)).config;
  }
  async function notifyDeps(): Promise<NotifyDeps> {
    return {
      db: deps.db,
      bus: deps.bus,
      smtp: await mailSmtp(),
      webOrigin: deps.env.PUBLIC_URL,
      log: deps.log,
    };
  }
  async function hookDeps(): Promise<HookDeps> {
    const smtp = await mailSmtp();
    return {
      db: deps.db,
      key: deps.env.AUTH_ENCRYPTION_KEY,
      smtp,
      log: deps.log,
      notify: async (items: NotificationInput[]) =>
        notify(await notifyDeps(), items),
    };
  }
  async function automationDeps(): Promise<AutomationDeps> {
    return {
      db: deps.db,
      bus: deps.bus,
      smtp: await mailSmtp(),
      webOrigin: deps.env.PUBLIC_URL,
      log: deps.log,
    };
  }
  const sealDeps: SealDeps = {
    db: deps.db,
    log: deps.log,
    notify: async (items) => notify(await notifyDeps(), items),
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
    envAttachmentMaxBytes: deps.env.ATTACHMENT_MAX_BYTES,
    exportMaxRows: deps.env.EXPORT_MAX_ROWS,
    importMaxRows: deps.env.IMPORT_MAX_ROWS,
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
    [TASKS.webhooksEvent]: consumer(async (event) =>
      handleWebhookEvent(await hookDeps(), event),
    ),
    [TASKS.webhookAttempt]: async (payload) => {
      const { deliveryId } = deliveryPayloadSchema.parse(payload);
      await runDeliveryAttempt(await hookDeps(), deliveryId);
    },
    [TASKS.assignmentsEvent]: consumer(async (event) =>
      handleAssignments(await notifyDeps(), event),
    ),
    [TASKS.automationsEvent]: consumer(async (event) =>
      handleAutomationEvent(await automationDeps(), event),
    ),
    [TASKS.automationRun]: async (payload) => {
      const input = automationRunPayloadSchema.parse(payload);
      await runQueuedAutomation(await automationDeps(), input);
    },
    [TASKS.automationSchedules]: async () => {
      await runDueSchedules(await automationDeps());
    },
    [TASKS.jobsRecover]: async () => {
      await recoverJobs(queueDeps);
    },
    [TASKS.webhookSweep]: async () => {
      await sweepDeliveries(deps.db);
    },
    [TASKS.alerts]: async () => {
      await checkAlerts({
        db: deps.db,
        files: deps.files,
        env: deps.env,
        log: deps.log,
        certificateExpires: deps.certificateExpires ?? (() => null),
      });
    },
    [TASKS.purge]: async () => {
      await purgeDeliveries(deps.db);
      await purgeAuthEvents(
        deps.db,
        (await readSettings(deps.db)).authRetentionDays,
      );
      await purgeResetLinks(deps.db);
      await purgeSignupRequests(deps.db);
      await purgeExpiredSignIns(deps.db);
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
      await purgeStagedAttachments(deps.db, deps.files, (error) => {
        deps.log(error, "staged attachment delete failed");
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
    [TASKS.operatorMail]: async (payload) => {
      const parsed = operatorMailPayloadSchema.parse(payload);
      await deliverOperatorMail(
        {
          db: deps.db,
          smtp: await mailSmtp(),
          log: deps.log,
        },
        parsed,
      );
    },
    [TASKS.siemEvent]: async (payload) => {
      const parsed = z
        .object({
          action: z.string(),
          userId: z.uuid().nullable(),
          actorId: z.uuid().nullable(),
          method: z.string().nullable(),
          detail: z.string().nullable(),
          ip: z.string().nullable(),
          occurredAt: z.string(),
        })
        .parse(payload);
      await deliverSiemEvent(deps.db, deps.env.AUTH_ENCRYPTION_KEY, {
        ...parsed,
        action: parsed.action as import("@anygriddb/db").AuthAction,
      });
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
          // What administrators are told about: late backups, storage,
          // the certificate, sources, failures (ROADMAP #25).
          task: TASKS.alerts,
          match: "*/10 * * * *",
          options: once,
          identifier: "alerts",
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
