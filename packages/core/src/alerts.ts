/**
 * What an instance tells its administrators about (ROADMAP #17, #25): a
 * backup that is late or failed, storage nearly full, a certificate close
 * to its end, a source out of reach, failures piling up. Which alerts are
 * due is decided here, from facts the server gathers and the thresholds
 * the administrators chose: nothing here reads a clock or a database.
 */
import type { InstanceSettings } from "./instance";

export const ALERT_KINDS = [
  "backup_late",
  "backup_failed",
  "storage_full",
  "certificate_expiring",
  "source_unreachable",
  "failures",
] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

/** Hours between two mails about an alert that stays open. */
export const ALERT_REMINDER_HOURS = 24;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** What the server found when it last looked. */
export type AlertFacts = {
  /** The last backup reported, and the last that succeeded; null if none. */
  lastBackup: { finishedAt: Date; succeeded: boolean } | null;
  lastGoodBackup: { finishedAt: Date } | null;
  /** Percent used of the volume the files are on; null when not a disk. */
  storagePercent: number | null;
  /** When the certificate people are served expires; null without TLS. */
  certificateExpires: Date | null;
  /** Sources with a watched table that could not be read. */
  unreachableSources: ReadonlyArray<{ id: string; name: string }>;
  /** Failed jobs, webhook deliveries, and automation runs in 24 hours. */
  failures: number;
};

/** An alert that should be open: its kind, what it is about, and why. */
export type DueAlert = {
  kind: AlertKind;
  /** What it is about within its kind: a source's id, or nothing. */
  subject: string;
  detail: Record<string, string | number | null>;
};

type AlertSettings = Pick<
  InstanceSettings,
  | "alertBackupHours"
  | "alertStoragePercent"
  | "alertCertificateDays"
  | "alertSources"
  | "alertFailures"
>;

/**
 * The alerts that should be open now. A kind turned off is never due,
 * and a backup is never late before a first one was reported: an instance
 * backed up by other means is not told every day that it is not.
 */
export function dueAlerts(
  settings: AlertSettings,
  facts: AlertFacts,
  now: Date,
): DueAlert[] {
  const due: DueAlert[] = [];
  if (settings.alertBackupHours > 0 && facts.lastBackup) {
    const good = facts.lastGoodBackup?.finishedAt ?? null;
    const lastGoodAt = good ? good.toISOString() : null;
    if (!facts.lastBackup.succeeded) {
      due.push({
        kind: "backup_failed",
        subject: "",
        detail: {
          failedAt: facts.lastBackup.finishedAt.toISOString(),
          lastGoodAt,
        },
      });
    }
    if (
      !good ||
      now.getTime() - good.getTime() > settings.alertBackupHours * HOUR_MS
    ) {
      due.push({
        kind: "backup_late",
        subject: "",
        detail: { hours: settings.alertBackupHours, lastGoodAt },
      });
    }
  }
  if (
    settings.alertStoragePercent > 0 &&
    facts.storagePercent !== null &&
    facts.storagePercent >= settings.alertStoragePercent
  ) {
    due.push({
      kind: "storage_full",
      subject: "",
      detail: {
        percent: facts.storagePercent,
        threshold: settings.alertStoragePercent,
      },
    });
  }
  if (settings.alertCertificateDays > 0 && facts.certificateExpires) {
    const left = facts.certificateExpires.getTime() - now.getTime();
    if (left <= settings.alertCertificateDays * DAY_MS) {
      due.push({
        kind: "certificate_expiring",
        subject: "",
        detail: {
          expiresAt: facts.certificateExpires.toISOString(),
          days: Math.max(0, Math.floor(left / DAY_MS)),
        },
      });
    }
  }
  if (settings.alertSources) {
    for (const source of facts.unreachableSources) {
      due.push({
        kind: "source_unreachable",
        subject: source.id,
        detail: { name: source.name },
      });
    }
  }
  if (settings.alertFailures > 0 && facts.failures >= settings.alertFailures) {
    due.push({
      kind: "failures",
      subject: "",
      detail: { count: facts.failures, threshold: settings.alertFailures },
    });
  }
  return due;
}

/**
 * Whether administrators are mailed about an open alert now: when it
 * opens, then at most once a day while it stays open.
 */
export function alertMailDue(notifiedAt: Date | null, now: Date): boolean {
  return (
    notifiedAt === null ||
    now.getTime() - notifiedAt.getTime() >= ALERT_REMINDER_HOURS * HOUR_MS
  );
}
