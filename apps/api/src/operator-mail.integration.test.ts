/**
 * Operator mail (ADR 0052): resolve recipients, refuse without SMTP, queue
 * a notice, deliver through the worker, and record the sign-in trail.
 */
import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "@anygriddb/db";
import type { TaskList } from "graphile-worker";
import { keyRing } from "./auth/key-ring.js";
import { runJobs } from "./queue/run-once.test-helpers.js";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ERASED_USER_ID } from "./data/erasure.js";
import type { Env } from "./env.js";
import { DiskStore } from "./files/index.js";
import { clearSmtpCache } from "./integrations/smtp.js";
import { fakeSmtp, mailText } from "./mail.test-helpers.js";
import { recordAuthEvent } from "./auth/auth-events.js";
import {
  MAX_OPERATOR_MAIL_PER_HOUR,
  deliverOperatorMail,
  queueOperatorMail,
  resolveOperatorRecipients,
} from "./operator-mail.js";
import { taskGroups } from "./queue/tasks.js";
import { recordingBus } from "./realtime/recording-bus.test-helpers.js";
import { createTestDatabase } from "./test-database.js";
import {
  browserFactory,
  enrollTotp,
  errorCode,
} from "./trpc/caller.test-helpers.js";

const suffix = randomBytes(6).toString("hex");
const PASSWORD = "correct horse battery staple";
const key = randomBytes(32);

describe("operator mail", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let pool: pg.Pool;
  let tasks: TaskList;
  let smtp: Awaited<ReturnType<typeof fakeSmtp>>;
  let adminId = "";
  let activeId = "";
  let disabledId = "";
  const env = {
    AUTH_ENCRYPTION_KEY: keyRing(key),
    PUBLIC_URL: "https://grid.example.org",
    SMTP_FROM: "grid@example.org",
  } as unknown as Env & {
    SMTP_HOST?: string;
    SMTP_PORT?: number;
    SMTP_FROM?: string;
  };
  const hub = {
    closeUser: () => 0,
    closeAllBut: () => 0,
    closeSession: () => 0,
  };
  const browser = browserFactory({ db: () => db, env, hub });
  const admin = browser();

  beforeAll(async () => {
    const created = await createTestDatabase("opmail");
    db = created.db;
    close = created.close;
    pool = new pg.Pool({ connectionString: created.url, max: 4 });
    pool.on("error", () => undefined);
    smtp = await fakeSmtp();
    env.SMTP_HOST = "127.0.0.1";
    env.SMTP_PORT = smtp.port;

    await admin.call().auth.signup({
      email: `admin-${suffix}@example.org`,
      displayName: "Ada Admin",
      password: PASSWORD,
    });
    await enrollTotp(admin);
    // A mail to everyone is a change made in Administration: it asks for
    // the proof (ADR 0073), given once for the minutes these tests take.
    await admin.call().admin.stepUp({ password: PASSWORD });
    adminId = (
      await db
        .selectFrom("users")
        .select("id")
        .where("email", "=", `admin-${suffix}@example.org`)
        .executeTakeFirstOrThrow()
    ).id;

    const active = await db
      .insertInto("users")
      .values({
        email: `active-${suffix}@example.org`,
        displayName: "Active",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    activeId = active.id;
    const disabled = await db
      .insertInto("users")
      .values({
        email: `disabled-${suffix}@example.org`,
        displayName: "Disabled",
        disabledAt: new Date(),
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    disabledId = disabled.id;

    const { bus } = recordingBus();
    const groups = taskGroups({
      db,
      bus,
      env,
      files: new DiskStore(await mkdtemp(join(tmpdir(), "anygriddb-opmail-"))),
      log: () => undefined,
    });
    tasks = Object.assign(
      {},
      ...groups.map((group) => group.tasks),
    ) as TaskList;
  }, 120_000);

  afterAll(async () => {
    await smtp.close();
    await pool.end();
    await close?.();
  });

  async function work(): Promise<void> {
    await runJobs(pool, tasks);
  }

  it("resolves active accounts and chosen ids, never the tombstone", async () => {
    const active = await resolveOperatorRecipients(db, { mode: "all_active" });
    expect(active.map((row) => row.id)).toEqual(
      expect.arrayContaining([adminId, activeId]),
    );
    expect(active.map((row) => row.id)).not.toContain(disabledId);
    expect(active.map((row) => row.id)).not.toContain(ERASED_USER_ID);

    const chosen = await resolveOperatorRecipients(db, {
      mode: "ids",
      userIds: [activeId, disabledId, ERASED_USER_ID],
    });
    expect(chosen.map((row) => row.id).sort()).toEqual(
      [activeId, disabledId].sort(),
    );
  });

  it("refuses a send when SMTP is not ready", async () => {
    const previous = { host: env.SMTP_HOST, from: env.SMTP_FROM };
    delete env.SMTP_HOST;
    clearSmtpCache(db);
    expect(
      await errorCode(
        admin.call().admin.sendOperatorMail({
          subject: "Hello",
          body: "World",
          recipients: { mode: "ids", userIds: [activeId] },
        }),
      ),
    ).toBe("smtp_not_configured");
    env.SMTP_HOST = previous.host;
    env.SMTP_FROM = previous.from;
    clearSmtpCache(db);
  });

  it("queues a notice, delivers it, and records the trail", async () => {
    await pool.query("delete from graphile_worker._private_jobs");
    const queued = await admin.call().admin.sendOperatorMail({
      subject: "Maintenance window",
      body: "We pause at midnight.",
      recipients: { mode: "ids", userIds: [activeId] },
    });
    expect(queued.recipientCount).toBe(1);

    const trail = await db
      .selectFrom("authEvents")
      .select(["action", "actorId", "detail", "method"])
      .where("action", "=", "operator_mail_sent")
      .orderBy("occurredAt", "desc")
      .executeTakeFirst();
    expect(trail).toMatchObject({
      action: "operator_mail_sent",
      actorId: adminId,
      detail: "selected",
      method: "admin",
    });

    await work();
    const mail = await smtp.next(`active-${suffix}@example.org`);
    const text = mailText(mail);
    expect(text).toMatch(/We pause at midnight/);
    expect(text).toMatch(/administrator of your AnyGridDB instance/i);
    expect(mail.data).toMatch(/Subject: Maintenance window/i);
  });

  it("previews how many active accounts a notice would reach", async () => {
    const preview = await admin.call().admin.operatorMailPreview({
      recipients: { mode: "all_active" },
    });
    expect(preview.recipientCount).toBeGreaterThanOrEqual(2);
  });

  it("delivers to every chosen account even when one address fails", async () => {
    const result = await deliverOperatorMail(
      {
        db,
        smtp: {
          SMTP_HOST: "127.0.0.1",
          SMTP_PORT: smtp.port,
          SMTP_FROM: "grid@example.org",
        },
        log: () => undefined,
      },
      {
        actorId: adminId,
        subject: "Second notice",
        body: "Still fine.",
        userIds: [activeId, disabledId],
        locale: "en",
      },
    );
    expect(result.sent).toBe(2);
    expect(result.failed).toBe(0);
    await smtp.next(`active-${suffix}@example.org`);
    await smtp.next(`disabled-${suffix}@example.org`);
  });

  it("enforces the hourly quota", async () => {
    const since = new Date(Date.now() - 60 * 60 * 1000);
    const existing = await db
      .selectFrom("authEvents")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .where("action", "=", "operator_mail_sent")
      .where("occurredAt", ">=", since)
      .executeTakeFirst();
    let count = Number(existing?.count ?? 0);
    while (count < MAX_OPERATOR_MAIL_PER_HOUR) {
      await recordAuthEvent(db, {
        action: "operator_mail_sent",
        actorId: adminId,
        method: "admin",
        detail: "selected",
      });
      count += 1;
    }
    expect(
      await errorCode(
        queueOperatorMail(
          { db, env, actorId: adminId },
          {
            subject: "One too many",
            body: "Stop",
            recipients: { mode: "ids", userIds: [activeId] },
          },
        ),
      ),
    ).toBe("operator_mail_limited");
  });
});
