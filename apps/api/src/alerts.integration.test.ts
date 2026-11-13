/**
 * Backups reported and alerts kept in step (ROADMAP #17, #25), against a
 * real database and a mail server on the loopback.
 */
import { randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  alertOptOuts,
  alertRecipients,
  checkAlerts,
  listBackups,
  listOpenAlerts,
  recordBackup,
  setAlertChoice,
  type AlertDeps,
} from "./alerts.js";
import type { FileStore } from "./files/index.js";
import { clearSmtpCache } from "./integrations/smtp.js";
import { fakeSmtp, mailText } from "./mail.test-helpers.js";
import { writeSettings } from "./settings.js";
import { createTestDatabase } from "./test-database.js";

const suffix = randomBytes(6).toString("hex");
const HOUR_MS = 3_600_000;
const start = new Date("2026-11-13T12:00:00Z");
const later = (hours: number) => new Date(start.getTime() + hours * HOUR_MS);

describe("alerts for administrators", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let smtp: Awaited<ReturnType<typeof fakeSmtp>>;
  let deps: AlertDeps;
  let adminId = "";
  let certificate: string | null = null;
  const ada = `ada-${suffix}@example.org`;
  const grace = `grace-${suffix}@example.org`;

  const kinds = async () =>
    (await listOpenAlerts(db)).map((alert) => alert.kind);
  /** The mails received since the last look, by who got them. */
  const mailed = () => {
    const seen = smtp.received.splice(0);
    return seen.map((mail) => mail.to.join(",")).sort();
  };

  beforeAll(async () => {
    const created = await createTestDatabase("alerts");
    db = created.db;
    close = created.close;
    smtp = await fakeSmtp();
    const people = await db
      .insertInto("users")
      .values([
        { email: ada, displayName: "Ada", isAdmin: true },
        { email: grace, displayName: "Grace", isAdmin: true },
        {
          email: `gone-${suffix}@example.org`,
          displayName: "Gone",
          isAdmin: true,
          disabledAt: new Date(),
        },
        { email: `member-${suffix}@example.org`, displayName: "Member" },
      ])
      .returning("id")
      .execute();
    adminId = people[0]?.id ?? "";
    deps = {
      db,
      // Not a disk: there is no volume to measure.
      files: { driver: "s3" } as unknown as FileStore,
      env: {
        PUBLIC_URL: "https://grid.example.org",
        SMTP_HOST: "127.0.0.1",
        SMTP_PORT: smtp.port,
        SMTP_FROM: "grid@example.org",
      } as unknown as AlertDeps["env"],
      log: (error) => {
        throw error;
      },
      certificateExpires: () => certificate,
    };
    clearSmtpCache(db);
  }, 120_000);

  afterAll(async () => {
    await smtp.close();
    await close?.();
  });

  beforeEach(async () => {
    await db.deleteFrom("backupRuns").execute();
    await db.deleteFrom("instanceAlerts").execute();
    certificate = null;
    smtp.received.length = 0;
  });

  const backup = (hoursBefore: number, succeeded = true) =>
    db
      .insertInto("backupRuns")
      .values({
        name: `anygriddb-${String(hoursBefore)}`,
        startedAt: later(-hoursBefore - 1),
        finishedAt: later(-hoursBefore),
        succeeded,
        bytes: "1048576",
      })
      .execute();

  it("says nothing about backups before one is reported", async () => {
    expect(await checkAlerts(deps, start)).toBe(0);
    expect(await kinds()).toEqual([]);
    expect(mailed()).toEqual([]);
  });

  it("opens a late backup, mails the administrators once a day, and closes it", async () => {
    await backup(40);
    expect(await checkAlerts(deps, start)).toBe(1);
    expect(await kinds()).toEqual(["backup_late"]);
    // Every active administrator, and nobody else.
    const first = smtp.received.slice();
    expect(mailed()).toEqual([ada, grace].sort());
    const text = mailText(first[0] ?? { from: "", to: [], data: "" });
    expect(text).toContain("the backup is late");
    expect(text).toContain("No backup has succeeded for more than 36 hours");
    expect(text).toContain("https://grid.example.org/admin/instance/health");

    // Still open an hour later: shown, not mailed again.
    await checkAlerts(deps, later(1));
    expect(await kinds()).toEqual(["backup_late"]);
    expect(mailed()).toEqual([]);
    // A day later: one reminder.
    await checkAlerts(deps, later(25));
    expect(mailed()).toEqual([ada, grace].sort());

    // A backup succeeds: the alert closes by itself, without a mail.
    await recordBackup(db, {
      name: "anygriddb-new",
      startedAt: later(25),
      succeeded: true,
      bytes: 2_097_152,
      encrypted: true,
    });
    expect(await checkAlerts(deps, later(26))).toBe(0);
    expect(await kinds()).toEqual([]);
    expect(mailed()).toEqual([]);
    expect((await listBackups(db, 1))[0]).toMatchObject({
      name: "anygriddb-new",
      succeeded: true,
      bytes: 2_097_152,
      encrypted: true,
    });
  });

  it("tells a failed backup from a late one, in one mail", async () => {
    await backup(30);
    await backup(2, false);
    await checkAlerts(deps, start);
    expect(await kinds()).toEqual(["backup_failed"]);
    mailed();
    // Ten hours on, the last good one is too old as well.
    await checkAlerts(deps, later(10));
    expect((await kinds()).sort()).toEqual(["backup_failed", "backup_late"]);
    // Only the alert that just opened is mailed: the other was, today.
    const mails = smtp.received.slice();
    expect(mailed()).toEqual([ada, grace].sort());
    expect(mailText(mails[0] ?? { from: "", to: [], data: "" })).not.toContain(
      "The last backup failed",
    );
  });

  it("follows the thresholds administrators set, and a kind turned off", async () => {
    certificate = later(24 * 5).toISOString();
    await checkAlerts(deps, start);
    expect(await kinds()).toEqual(["certificate_expiring"]);
    expect((await listOpenAlerts(db))[0]?.detail).toEqual({
      expiresAt: certificate,
      days: 5,
    });
    await writeSettings(db, adminId, { alertCertificateDays: 0 });
    try {
      expect(await checkAlerts(deps, later(1))).toBe(0);
      expect(await kinds()).toEqual([]);
    } finally {
      await writeSettings(db, adminId, { alertCertificateDays: 14 });
    }
  });

  it("spares an administrator the kinds they asked not to be told about", async () => {
    const graceId = (
      await db
        .selectFrom("users")
        .select("id")
        .where("email", "=", grace)
        .executeTakeFirstOrThrow()
    ).id;
    await setAlertChoice(db, graceId, "backup_late", false);
    await setAlertChoice(db, graceId, "backup_late", false);
    expect(await alertOptOuts(db, graceId)).toEqual(["backup_late"]);
    try {
      // A late backup and a certificate close to its end, at once.
      await backup(40);
      certificate = later(24 * 3).toISOString();
      await checkAlerts(deps, start);
      expect((await kinds()).sort()).toEqual([
        "backup_late",
        "certificate_expiring",
      ]);
      const mails = smtp.received.splice(0);
      const textOf = (to: string) =>
        mailText(
          mails.find((mail) => mail.to.includes(to)) ?? {
            from: "",
            to: [],
            data: "",
          },
        );
      // Ada is told of both; Grace of the certificate alone.
      expect(textOf(ada)).toContain("No backup has succeeded");
      expect(textOf(ada)).toContain("certificate expires");
      expect(textOf(grace)).toContain("certificate expires");
      expect(textOf(grace)).not.toContain("No backup has succeeded");
      // The lock of an account goes by the same choices.
      expect(
        (await alertRecipients(db, "backup_late")).map((admin) => admin.email),
      ).toEqual([ada]);
      expect(
        (await alertRecipients(db, "account_locked", adminId)).map(
          (admin) => admin.email,
        ),
      ).toEqual([grace]);
    } finally {
      await setAlertChoice(db, graceId, "backup_late", true);
    }
    expect(await alertOptOuts(db, graceId)).toEqual([]);
  });

  it("opens each alert once when two processes check at the same time", async () => {
    await backup(40);
    await Promise.all([checkAlerts(deps, start), checkAlerts(deps, start)]);
    expect(await kinds()).toEqual(["backup_late"]);
    expect(mailed()).toEqual([ada, grace].sort());
  });

  it("forgets closed alerts and old reports after their time", async () => {
    await backup(40);
    await checkAlerts(deps, start);
    await backup(0);
    await checkAlerts(deps, later(1));
    // Closed alerts stay ninety days, a backup's report four hundred.
    await checkAlerts(deps, later(24 * 91));
    const alerts = await db.selectFrom("instanceAlerts").selectAll().execute();
    // The one of then is forgotten; today's, about the same backup, is open.
    expect(alerts.map((alert) => alert.closedAt)).toEqual([null]);
    await checkAlerts(deps, later(24 * 401));
    expect(await listBackups(db, 10)).toEqual([]);
  });
});
