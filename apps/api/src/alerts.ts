/**
 * What an instance tells its administrators about (ROADMAP #17, #25):
 * the backups an operator's script reports, and the alerts kept in step
 * with what the server finds, by a scheduled task. Each alert is shown
 * in Administration while it is open, and mailed to the administrators
 * when it opens, then once a day at most.
 */
import { statfs } from "node:fs/promises";
import {
  alertMailDue,
  dueAlerts,
  type AlertChoice,
  type AlertFacts,
  type AlertKind,
  type DueAlert,
} from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { sql } from "kysely";
import { ERASED_USER_ID } from "./data/erasure.js";
import { liveTable } from "./data/live.js";
import { DiskStore } from "./files/disk.js";
import type { FileStore } from "./files/index.js";
import { resolveSmtp } from "./integrations/smtp.js";
import { sendMail, smtpReady } from "./mail.js";
import { alertMailBody, alertMailSubject } from "./mail-i18n.js";
import { readMailVoice, readSettings } from "./settings.js";

const DAY_MS = 86_400_000;
/** How long a closed alert and a backup's report are kept. */
const CLOSED_ALERT_DAYS = 90;
const BACKUP_RUN_DAYS = 400;

type BackupRun = {
  id: string;
  startedAt: string;
  finishedAt: string;
  succeeded: boolean;
  bytes: number | null;
  encrypted: boolean;
  name: string;
};

type OpenAlert = {
  id: string;
  kind: AlertKind;
  subject: string;
  detail: Record<string, string | number | null>;
  openedAt: string;
};

/** Writes down a backup its script reports: when, how it ended, its weight. */
export async function recordBackup(
  db: Database,
  input: {
    startedAt: Date;
    succeeded: boolean;
    bytes: number | null;
    encrypted: boolean;
    name: string;
  },
): Promise<void> {
  await db.insertInto("backupRuns").values(input).execute();
}

/** The last backups reported, newest first. */
export async function listBackups(
  db: Database,
  limit: number,
): Promise<BackupRun[]> {
  const rows = await db
    .selectFrom("backupRuns")
    .selectAll()
    .orderBy("finishedAt", "desc")
    .orderBy("id", "desc")
    .limit(limit)
    .execute();
  return rows.map((row) => ({
    id: row.id,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt.toISOString(),
    succeeded: row.succeeded,
    bytes: row.bytes === null ? null : Number(row.bytes),
    encrypted: row.encrypted,
    name: row.name,
  }));
}

/** The alerts open now, oldest first. */
export async function listOpenAlerts(db: Database): Promise<OpenAlert[]> {
  const rows = await db
    .selectFrom("instanceAlerts")
    .select(["id", "kind", "subject", "detail", "openedAt"])
    .where("closedAt", "is", null)
    .orderBy("openedAt", "asc")
    .orderBy("id", "asc")
    .execute();
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind as AlertKind,
    subject: row.subject,
    detail: row.detail,
    openedAt: row.openedAt.toISOString(),
  }));
}

/** Percent used of the volume a disk store is on; null for any other. */
async function storagePercent(files: FileStore): Promise<number | null> {
  if (!(files instanceof DiskStore)) return null;
  try {
    const volume = await statfs(files.root);
    if (volume.blocks <= 0) return null;
    return Math.round(100 - (volume.bavail / volume.blocks) * 100);
  } catch {
    // The folder is away: the storage check of Health already says so.
    return null;
  }
}

type AlertProbes = {
  db: Database;
  files: FileStore;
  /** When the certificate people are served expires; null without TLS. */
  certificateExpires: () => string | null;
};

/** What the alerts are decided from, read now. */
async function alertFacts(deps: AlertProbes, now: Date): Promise<AlertFacts> {
  const since = new Date(now.getTime() - DAY_MS);
  const [last, lastGood] = await Promise.all(
    [false, true].map((onlyGood) =>
      deps.db
        .selectFrom("backupRuns")
        .select(["finishedAt", "succeeded"])
        .$if(onlyGood, (query) => query.where("succeeded", "=", true))
        .orderBy("finishedAt", "desc")
        .orderBy("id", "desc")
        .limit(1)
        .executeTakeFirst(),
    ),
  );
  // A source is out of reach when the last check of one of its watched
  // tables could not connect; a check that reads it again clears this.
  const unreachableSources = await deps.db
    .selectFrom("externalWatches as w")
    .innerJoin("dataTables as t", "t.id", "w.tableId")
    .innerJoin("sources as s", "s.id", "t.sourceId")
    .select(["s.id", "s.name"])
    .where("w.errorCode", "=", "source_unreachable")
    .where(liveTable("t"))
    .distinct()
    .orderBy("s.name", "asc")
    .limit(100)
    .execute();
  const count = sql<number>`count(*)::int`.as("value");
  const [jobs, deliveries, runs] = await Promise.all([
    deps.db
      .selectFrom("jobs")
      .select(count)
      .where("status", "=", "failed")
      .where("createdAt", ">", since)
      .executeTakeFirst(),
    deps.db
      .selectFrom("webhookDeliveries")
      .select(count)
      .where("status", "=", "failed")
      .where("createdAt", ">", since)
      .executeTakeFirst(),
    deps.db
      .selectFrom("automationRuns")
      .select(count)
      .where("status", "=", "failed")
      .where("startedAt", ">", since)
      .executeTakeFirst(),
  ]);
  const expires = deps.certificateExpires();
  return {
    lastBackup: last ?? null,
    lastGoodBackup: lastGood ?? null,
    storagePercent: await storagePercent(deps.files),
    certificateExpires: expires ? new Date(expires) : null,
    unreachableSources,
    failures:
      (jobs?.value ?? 0) + (deliveries?.value ?? 0) + (runs?.value ?? 0),
  };
}

/**
 * Brings the open alerts in step with the ones due: opens the new ones,
 * refreshes what the others say, closes those no longer due. Answers the
 * alerts whose mail is due, marked as mailed now: two processes running
 * this at once mail each alert once.
 */
async function syncAlerts(
  db: Database,
  due: readonly DueAlert[],
  now: Date,
): Promise<OpenAlert[]> {
  return db.transaction().execute(async (tx) => {
    // One process at a time: the comparison below must see the other's.
    await sql`select pg_advisory_xact_lock(hashtext('instance_alerts'))`.execute(
      tx,
    );
    const open = await tx
      .selectFrom("instanceAlerts")
      .select(["id", "kind", "subject", "notifiedAt"])
      .where("closedAt", "is", null)
      .execute();
    const key = (alert: { kind: string; subject: string }) =>
      `${alert.kind}\n${alert.subject}`;
    const wanted = new Map(due.map((alert) => [key(alert), alert]));
    const gone = open.filter((alert) => !wanted.has(key(alert)));
    if (gone.length > 0) {
      await tx
        .updateTable("instanceAlerts")
        .set({ closedAt: now })
        .where(
          "id",
          "in",
          gone.map((alert) => alert.id),
        )
        .execute();
    }
    const known = new Map(open.map((alert) => [key(alert), alert]));
    const toMail: OpenAlert[] = [];
    for (const alert of due) {
      const existing = known.get(key(alert));
      const mail = alertMailDue(existing?.notifiedAt ?? null, now);
      const row = existing
        ? await tx
            .updateTable("instanceAlerts")
            .set({
              detail: alert.detail,
              ...(mail ? { notifiedAt: now } : {}),
            })
            .where("id", "=", existing.id)
            .returning(["id", "openedAt"])
            .executeTakeFirstOrThrow()
        : await tx
            .insertInto("instanceAlerts")
            .values({
              kind: alert.kind,
              subject: alert.subject,
              detail: alert.detail,
              openedAt: now,
              notifiedAt: now,
            })
            .returning(["id", "openedAt"])
            .executeTakeFirstOrThrow();
      if (mail) {
        toMail.push({
          ...alert,
          id: row.id,
          openedAt: row.openedAt.toISOString(),
        });
      }
    }
    return toMail;
  });
}

export type AlertDeps = AlertProbes & {
  env: Parameters<typeof resolveSmtp>[1] & { PUBLIC_URL: string };
  log: (error: unknown, message: string) => void;
};

/**
 * The active administrators who are told of this kind of alert: all of
 * them, but those who asked not to be (ROADMAP #48).
 */
export async function alertRecipients(
  db: Database,
  kind: AlertChoice,
  exceptUserId?: string,
): Promise<Array<{ id: string; email: string }>> {
  return db
    .selectFrom("users as u")
    .select(["u.id", "u.email"])
    .where("u.isAdmin", "=", true)
    .where("u.disabledAt", "is", null)
    .where("u.id", "<>", ERASED_USER_ID)
    .$if(exceptUserId !== undefined, (query) =>
      query.where("u.id", "<>", exceptUserId ?? ""),
    )
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom("alertOptouts as o")
            .select("o.kind")
            .whereRef("o.userId", "=", "u.id")
            .where("o.kind", "=", kind),
        ),
      ),
    )
    .orderBy("u.email", "asc")
    .execute();
}

/** The kinds an administrator asked not to be told about. */
export async function alertOptOuts(
  db: Database,
  userId: string,
): Promise<AlertChoice[]> {
  const rows = await db
    .selectFrom("alertOptouts")
    .select("kind")
    .where("userId", "=", userId)
    .orderBy("kind", "asc")
    .execute();
  return rows.map((row) => row.kind as AlertChoice);
}

/** Tells an administrator of a kind of alert again, or no longer. */
export async function setAlertChoice(
  db: Database,
  userId: string,
  kind: AlertChoice,
  receive: boolean,
): Promise<void> {
  if (receive) {
    await db
      .deleteFrom("alertOptouts")
      .where("userId", "=", userId)
      .where("kind", "=", kind)
      .execute();
    return;
  }
  await db
    .insertInto("alertOptouts")
    .values({ userId, kind })
    .onConflict((conflict) => conflict.doNothing())
    .execute();
}

/**
 * One mail to each active administrator, naming the alerts given that
 * they did not ask to be spared; none to someone spared all of them.
 */
async function mailAlerts(
  deps: AlertDeps,
  alerts: readonly OpenAlert[],
): Promise<void> {
  const { config: smtp } = await resolveSmtp(deps.db, deps.env);
  if (!smtpReady(smtp)) return;
  const recipients = new Map<string, OpenAlert[]>();
  for (const kind of new Set(alerts.map((alert) => alert.kind))) {
    for (const admin of await alertRecipients(deps.db, kind)) {
      recipients.set(admin.email, [
        ...(recipients.get(admin.email) ?? []),
        ...alerts.filter((alert) => alert.kind === kind),
      ]);
    }
  }
  const voice = await readMailVoice(deps.db);
  const url = `${deps.env.PUBLIC_URL.replace(/\/+$/, "")}/admin/instance/health`;
  for (const [email, theirs] of recipients) {
    await sendMail(smtp, voice, {
      to: email,
      subject: alertMailSubject(voice, theirs),
      text: alertMailBody(voice, theirs, url),
    }).catch((error: unknown) => {
      deps.log(error, "alert mail failed");
    });
  }
}

/**
 * The scheduled check: reads the facts, keeps the alerts in step, mails
 * what is due, and forgets what is old. Answers how many alerts are open.
 */
export async function checkAlerts(
  deps: AlertDeps,
  now: Date = new Date(),
): Promise<number> {
  const settings = await readSettings(deps.db);
  const due = dueAlerts(settings, await alertFacts(deps, now), now);
  const toMail = await syncAlerts(deps.db, due, now);
  if (toMail.length > 0) await mailAlerts(deps, toMail);
  await deps.db
    .deleteFrom("instanceAlerts")
    .where(
      "closedAt",
      "<",
      new Date(now.getTime() - CLOSED_ALERT_DAYS * DAY_MS),
    )
    .execute();
  await deps.db
    .deleteFrom("backupRuns")
    .where(
      "finishedAt",
      "<",
      new Date(now.getTime() - BACKUP_RUN_DAYS * DAY_MS),
    )
    .execute();
  return due.length;
}
