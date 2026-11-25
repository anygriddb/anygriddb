/**
 * A notification channel (ADR 0092): saved from Administration, secret
 * sealed and never returned, a failed job delivered through the queue's
 * task, a private address refused until an administrator allows it.
 */
import { randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decryptSecret } from "../auth/crypto.js";
import { keyRing } from "../auth/key-ring.js";
import type { Env } from "../env.js";
import { createTestDatabase } from "../test-database.js";
import {
  browserFactory,
  enrollTotp,
  errorCode,
  signUpProved,
} from "../trpc/caller.test-helpers.js";
import { runDelivery } from "../outbound/deliveries.js";
import {
  channelDestination,
  notifyJobOutcome,
  testIntegration,
  type NotifyRuntime,
} from "./dispatch.js";
import { savedTracing } from "./tracing.js";

const suffix = randomBytes(6).toString("hex");
const PASSWORD = "correct horse battery staple";
const SECRET = "a-long-enough-secret";

/** One attempt of a channel's delivery, as the queue's task makes it. */
function runIntegrationDelivery(runtime: NotifyRuntime, deliveryId: string) {
  return runDelivery(
    runtime.db,
    {
      integration: channelDestination(runtime),
      webhook: {
        attempt: () => Promise.reject(new Error("no webhook in this test")),
      },
    },
    deliveryId,
  );
}

describe("notification channels", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  const env = {
    AUTH_ENCRYPTION_KEY: keyRing(randomBytes(32)),
    PUBLIC_URL: "https://grid.example.org",
  } as unknown as Env;
  const hub = {
    closeUser: () => 0,
    closeAllBut: () => 0,
    closeSession: () => 0,
  };
  const browser = browserFactory({ db: () => db, env, hub });
  const admin = browser();
  const member = browser();

  beforeAll(async () => {
    const created = await createTestDatabase("notify");
    db = created.db;
    close = created.close;
    await admin.signUpFirst({
      email: `admin-${suffix}@example.org`,
      displayName: "Ada Admin",
      password: PASSWORD,
    });
    await enrollTotp(admin);
    await admin.call().admin.stepUp({ password: PASSWORD });
    await signUpProved(member, db, {
      email: `member-${suffix}@example.org`,
      displayName: "Bea Member",
      password: PASSWORD,
    });
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  it("refuses someone who is not an administrator", async () => {
    expect(await errorCode(member.call().admin.notify.list())).toBe(
      "access_denied",
    );
  });

  it("refuses loopback and a private address, then allows the private one", async () => {
    expect(
      await errorCode(
        admin.call().admin.notify.create({
          provider: "webhook",
          name: "Loop",
          events: ["job.failed"],
          config: { url: "https://127.0.0.1/hook" },
          secrets: { secret: SECRET },
        }),
      ),
    ).toBe("invalid_notify_target");
    expect(
      await errorCode(
        admin.call().admin.notify.create({
          provider: "webhook",
          name: "Lan",
          events: ["job.failed"],
          config: { url: "https://10.1.2.3/hook" },
          secrets: { secret: SECRET },
        }),
      ),
    ).toBe("invalid_notify_target");
    await admin.call().admin.updateSettings({ notifyAllowPrivate: true });
    const saved = await admin.call().admin.notify.create({
      provider: "webhook",
      name: "Lan",
      events: ["job.failed"],
      config: { url: "https://10.1.2.3/hook" },
      secrets: { secret: SECRET },
    });
    expect(saved.config).toEqual({ url: "https://10.1.2.3/hook" });
    expect(saved.secretsSet).toEqual(["secret"]);
    expect(JSON.stringify(saved)).not.toContain(SECRET);
    await admin.call().admin.notify.delete({ id: saved.id });
    await admin.call().admin.updateSettings({ notifyAllowPrivate: false });
  });

  it("asks for a saved secret again when a channel moves to another host", async () => {
    await admin.call().admin.updateSettings({ notifyAllowPrivate: true });
    const notify = () => admin.call().admin.notify;
    const saved = await notify().create({
      provider: "webhook",
      name: "Moved",
      events: ["job.failed"],
      config: { url: "https://10.1.2.3/hook" },
      secrets: { secret: SECRET },
    });
    await notify().update({
      id: saved.id,
      config: { url: "https://10.1.2.3/another-path" },
    });
    expect(
      await errorCode(
        notify().update({
          id: saved.id,
          config: { url: "https://10.1.2.4/hook" },
        }),
      ),
    ).toBe("notify_secret_again");
    const moved = await notify().update({
      id: saved.id,
      config: { url: "https://10.1.2.4/hook" },
      secrets: { secret: "another-long-enough-secret" },
    });
    expect(moved.config).toEqual({ url: "https://10.1.2.4/hook" });
    await notify().delete({ id: saved.id });
    await admin.call().admin.updateSettings({ notifyAllowPrivate: false });
  });

  it("starts no saved collector on an address no longer allowed", async () => {
    await admin.call().admin.updateSettings({ notifyAllowPrivate: true });
    const endpoint = "https://10.1.2.9:4318";
    const saved = await admin.call().admin.notify.create({
      provider: "otlp",
      name: "Traces",
      events: [],
      config: { endpoint },
      secrets: {},
    });
    const started = await savedTracing(db, env.AUTH_ENCRYPTION_KEY);
    expect(started.endpoint).toBe(endpoint);
    expect(started.lookup).toEqual(expect.any(Function));
    await admin.call().admin.updateSettings({ notifyAllowPrivate: false });
    expect(await savedTracing(db, env.AUTH_ENCRYPTION_KEY)).toEqual({});
    await admin.call().admin.notify.delete({ id: saved.id });
  });

  it("seals the secret, delivers a failed job, and pauses after repeated failures", async () => {
    const saved = await admin.call().admin.notify.create({
      provider: "webhook",
      name: "Ops",
      events: ["job.failed", "integration.failing"],
      config: { url: "https://203.0.113.10/hook" },
      secrets: { secret: SECRET, headers: { "X-Token": "abcdefghij" } },
    });
    expect(JSON.stringify(saved)).not.toContain(SECRET);
    expect(JSON.stringify(saved)).not.toContain("abcdefghij");
    const stored = await db
      .selectFrom("instanceIntegrations")
      .selectAll()
      .where("id", "=", saved.id)
      .executeTakeFirstOrThrow();
    expect(
      decryptSecret(
        stored.secretsCiphertext ?? Buffer.alloc(0),
        stored.secretsNonce ?? Buffer.alloc(0),
        env.AUTH_ENCRYPTION_KEY,
        "notify",
      ),
    ).toContain(SECRET);
    const trail = await db
      .selectFrom("authEvents")
      .select("detail")
      .where("detail", "=", "notify")
      .execute();
    expect(trail.length).toBeGreaterThan(0);

    const failed = {
      id: "11111111-1111-4111-8111-111111111111",
      kind: "export",
      status: "failed" as const,
      errorCode: "internal_error",
    };
    await notifyJobOutcome(db, () => undefined, failed);
    await notifyJobOutcome(db, () => undefined, failed);
    const queued = await db
      .selectFrom("deliveries")
      .selectAll()
      .where("integrationId", "=", saved.id)
      .execute();
    expect(queued).toHaveLength(1);
    const queuedDelivery = queued[0];
    if (!queuedDelivery) throw new Error("missing delivery");
    const seen: { signature?: string; body?: string } = {};
    await runIntegrationDelivery(
      {
        db,
        key: env.AUTH_ENCRYPTION_KEY,
        log: () => undefined,
        send: (request) => {
          seen.signature = request.headers?.["x-anygrid-signature"];
          seen.body = request.body;
          expect(request.headers?.["X-Token"]).toBe("abcdefghij");
          return Promise.resolve({ status: 204, body: "" });
        },
      },
      queuedDelivery.id,
    );
    expect(seen.body).toContain("job.failed");
    expect(seen.signature).toMatch(/^sha256=[0-9a-f]{64}$/);
    const done = await db
      .selectFrom("deliveries")
      .select("status")
      .where("id", "=", queuedDelivery.id)
      .executeTakeFirstOrThrow();
    expect(done.status).toBe("success");

    await db
      .updateTable("instanceIntegrations")
      .set({ consecutiveFailures: 4 })
      .where("id", "=", saved.id)
      .execute();
    await db
      .insertInto("deliveries")
      .values({
        integrationId: saved.id,
        eventId: "22222222-2222-4222-8222-222222222222",
        event: "job.failed",
        subject: "22222222-2222-4222-8222-222222222222",
        payload: { kind: "export", code: "internal_error" },
        attempts: 3,
      })
      .execute();
    const failing = await db
      .selectFrom("deliveries")
      .select("id")
      .where("eventId", "=", "22222222-2222-4222-8222-222222222222")
      .executeTakeFirstOrThrow();
    await runIntegrationDelivery(
      {
        db,
        key: env.AUTH_ENCRYPTION_KEY,
        log: () => undefined,
        send: () => Promise.resolve({ status: 500, body: SECRET }),
      },
      failing.id,
    );
    const paused = await db
      .selectFrom("instanceIntegrations")
      .select(["status", "consecutiveFailures", "lastError"])
      .where("id", "=", saved.id)
      .executeTakeFirstOrThrow();
    expect(paused.status).toBe("error");
    expect(paused.consecutiveFailures).toBe(5);
    expect(paused.lastError).not.toContain(SECRET);
    const listed = await admin.call().admin.notify.list();
    expect(JSON.stringify(listed)).not.toContain(SECRET);
  });

  it("pings a Healthchecks address when an administrator sends a test", async () => {
    // example.org resolves; the test never calls the network (outbound mocked).
    const ping =
      "https://example.org/ping/11111111-1111-4111-8111-111111111111";
    const saved = await admin.call().admin.notify.create({
      provider: "healthchecks",
      name: "Nightly",
      events: [],
      schedules: ["purge"],
      config: {},
      secrets: { pingUrl: ping },
    });
    expect(saved.secretsSet).toEqual(["pingUrl"]);
    expect(JSON.stringify(saved)).not.toContain(ping);
    const seen: { url?: string; method?: string } = {};
    const result = await testIntegration(
      {
        db,
        key: env.AUTH_ENCRYPTION_KEY,
        log: () => undefined,
        send: (request) => {
          seen.url = request.url;
          seen.method = request.method;
          return Promise.resolve({ status: 200, body: "OK" });
        },
      },
      saved.id,
    );
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(seen.method).toBe("GET");
    expect(seen.url).toBe(ping);
    await admin.call().admin.notify.delete({ id: saved.id });
  });

  it("rejects a Healthchecks test when the body says the check was not found", async () => {
    const ping =
      "https://example.org/ping/22222222-2222-4222-8222-222222222222";
    const saved = await admin.call().admin.notify.create({
      provider: "healthchecks",
      name: "Missing",
      events: [],
      schedules: ["purge"],
      config: {},
      secrets: { pingUrl: ping },
    });
    const result = await testIntegration(
      {
        db,
        key: env.AUTH_ENCRYPTION_KEY,
        log: () => undefined,
        send: () => Promise.resolve({ status: 200, body: "OK (not found)" }),
      },
      saved.id,
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBe(200);
    expect(result.error).toBe("HTTP 200");
    expect(JSON.stringify(result)).not.toContain(ping);
    await admin.call().admin.notify.delete({ id: saved.id });
  });

  it("needs the mail relay when an administrator tests an email channel", async () => {
    const saved = await admin.call().admin.notify.create({
      provider: "smtp",
      name: "Mail",
      events: ["job.failed"],
      schedules: [],
      config: { recipients: [`ops-${suffix}@example.org`] },
      secrets: {},
    });
    // Through the router (env is passed): no sealed SMTP on this database.
    const viaRouter = await admin.call().admin.notify.test({ id: saved.id });
    expect(viaRouter.ok).toBe(false);
    expect(viaRouter.error).toBe("Mail is not configured");
    // Without env, mailFor bails before resolveSmtp — same public answer.
    const withoutEnv = await testIntegration(
      {
        db,
        key: env.AUTH_ENCRYPTION_KEY,
        log: () => undefined,
      },
      saved.id,
    );
    expect(withoutEnv.ok).toBe(false);
    expect(withoutEnv.error).toBe("Mail is not configured");
    await admin.call().admin.notify.delete({ id: saved.id });
  });
});
