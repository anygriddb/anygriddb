/**
 * Sign-in events to a syslog collector (ADR 0084), against a real
 * database and queue: an event the collectors get is queued when the
 * process has a collector, delivered by the worker over verified TLS, and
 * rolled back with the transaction that made it.
 */
import { giveInstanceRole } from "../auth/instance-roles.test-helpers.js";
import { createPrivateKey, X509Certificate } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:tls";
import type { Database } from "@anygriddb/db";
import type { TaskList } from "graphile-worker";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recordAuthEvent } from "../auth/auth-events.js";
import { keyRing } from "../auth/key-ring.js";
import type { Env, SyslogCollector } from "../env.js";
import { DiskStore } from "../files/index.js";
import { runJobs } from "../queue/run-once.test-helpers.js";
import { taskGroups } from "../queue/tasks.js";
import { recordingBus } from "../realtime/recording-bus.test-helpers.js";
import { createTestDatabase } from "../test-database.js";
import { issueAuthority, issueServer } from "../tls/certificate.js";
import { writeSettings } from "../settings.js";
import { shipTrail } from "./trail-shipping.js";
import { verifyTrail } from "./trail-verify.js";
import {
  clearSyslog,
  deliverSyslogEvent,
  publicSyslog,
  saveSyslog,
  sendSyslogLine,
  sendSyslogTest,
  syslogUpdateSchema,
  watchSyslog,
  type SyslogReach,
} from "./syslog.js";

describe("sign-in events to a syslog collector", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let pool: pg.Pool;
  let tasks: TaskList;
  let server: Server;
  let collector: SyslogCollector;
  const received: string[] = [];
  const env = {
    AUTH_ENCRYPTION_KEY: keyRing(Buffer.alloc(32, 9)),
    PUBLIC_URL: "https://grid.example.org",
  } as unknown as Env;

  /** The syslog jobs waiting, by the action each carries. */
  async function waiting(): Promise<string[]> {
    const result = await pool.query<{ payload: { action: string } }>(
      `select p.payload
         from graphile_worker.jobs j
         join graphile_worker._private_jobs p on p.id = j.id
        where j.task_identifier = 'syslog_event'
        order by j.id`,
    );
    return result.rows.map((row) => row.payload.action);
  }

  beforeAll(async () => {
    const created = await createTestDatabase("syslog");
    db = created.db;
    close = created.close;
    pool = new pg.Pool({ connectionString: created.url, max: 4 });
    pool.on("error", () => undefined);

    const commonName = "AnyGridDB syslog test";
    const authority = issueAuthority({ commonName, names: ["localhost"] });
    const leaf = issueServer({
      names: ["localhost"],
      authority: {
        cert: authority.cert,
        key: createPrivateKey(authority.key),
        publicKey: new X509Certificate(authority.cert).publicKey,
        commonName,
      },
    });
    server = createServer({ key: leaf.key, cert: leaf.cert }, (socket) => {
      const chunks: Buffer[] = [];
      socket.on("data", (chunk: Buffer) => chunks.push(chunk));
      socket.on("end", () => {
        received.push(Buffer.concat(chunks).toString("utf8"));
        socket.end();
      });
      socket.on("error", () => undefined);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    collector = {
      host: "localhost",
      port: (server.address() as AddressInfo).port,
      ca: authority.cert,
    };

    const { bus } = recordingBus();
    const groups = taskGroups({
      db,
      bus,
      env,
      files: new DiskStore(await mkdtemp(join(tmpdir(), "anygriddb-syslog-"))),
      log: () => undefined,
    });
    tasks = Object.assign(
      {},
      ...groups.map((group) => group.tasks),
    ) as TaskList;
  }, 120_000);

  afterAll(async () => {
    watchSyslog(undefined);
    server.close();
    await pool.end();
    await close?.();
  });

  it("queues nothing while the process has no collector", async () => {
    watchSyslog(undefined);
    await recordAuthEvent(db, { action: "login_failure", ip: "192.0.2.10" });
    expect(await waiting()).toEqual([]);
  });

  it("queues the events a collector gets, with the transaction that made them", async () => {
    watchSyslog(collector);
    await recordAuthEvent(db, {
      action: "login_failure",
      method: "password",
      detail: "invalid_credentials",
      ip: "192.0.2.10",
    });
    // A sign-in that went well is on the trail, and sent nowhere.
    await recordAuthEvent(db, { action: "login_success", method: "password" });
    expect(await waiting()).toEqual(["login_failure"]);

    // An event of a transaction that fails leaves no job behind it.
    await expect(
      db.transaction().execute(async (tx) => {
        await recordAuthEvent(tx, { action: "account_locked" });
        throw new Error("rolled back");
      }),
    ).rejects.toThrow("rolled back");
    expect(await waiting()).toEqual(["login_failure"]);
  });

  it("is delivered by the worker, over the collector's verified certificate", async () => {
    env.SYSLOG = collector;
    await runJobs(pool, tasks);
    expect(await waiting()).toEqual([]);
    expect(received).toHaveLength(1);
    const [frame = ""] = received;
    const space = frame.indexOf(" ");
    const line = frame.slice(space + 1);
    expect(Number(frame.slice(0, space))).toBe(Buffer.byteLength(line));
    expect(line).toMatch(/^<133>1 \S+ \S+ anygriddb - auth - \{/);
    expect(JSON.parse(line.slice(line.indexOf("{")))).toMatchObject({
      source: "anygriddb",
      action: "login_failure",
      method: "password",
      detail: "invalid_credentials",
      ip: "192.0.2.10",
      userId: null,
    });
  });

  it("drops an event queued for a collector the environment no longer names", async () => {
    await recordAuthEvent(db, { action: "account_locked" });
    expect(await waiting()).toEqual(["account_locked"]);
    delete env.SYSLOG;
    await runJobs(pool, tasks);
    expect(await waiting()).toEqual([]);
    expect(received).toHaveLength(1);
  });

  describe("named in Administration", () => {
    let admin = "";
    /** The collector's name stands for the test's own, on the loopback. */
    const reach = (address: string): SyslogReach => ({
      resolve: () => Promise.resolve([{ address, family: 4 }]),
      send: (_named, line) => sendSyslogLine(collector, line),
    });
    const named = syslogUpdateSchema.parse({ host: "logs.example.org" });
    /** Forgets the jobs waiting: what an earlier test queued. */
    const drain = () =>
      pool.query(
        `select graphile_worker.complete_jobs(array(select id from graphile_worker.jobs))`,
      );

    beforeAll(async () => {
      watchSyslog(undefined);
      delete env.SYSLOG;
      const person = await db
        .insertInto("users")
        .values({
          email: "syslog-admin@example.com",
          displayName: "Admin",
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      admin = person.id;
      await giveInstanceRole(db, admin);
    });

    it("is refused while the environment names one, and saves nothing", async () => {
      await expect(
        saveSyslog(db, collector, admin, named, {
          reach: reach("203.0.113.10"),
        }),
      ).rejects.toMatchObject({ code: "set_by_environment" });
      expect(await publicSyslog(db, undefined)).toEqual({
        configured: false,
        saved: false,
      });
    });

    it("is refused on a private address until an administrator allows those", async () => {
      await expect(
        saveSyslog(db, undefined, admin, named, { reach: reach("10.1.2.3") }),
      ).rejects.toMatchObject({ code: "invalid_syslog_target" });
      expect(await publicSyslog(db, undefined)).toMatchObject({
        configured: false,
      });
      await writeSettings(db, admin, { notifyAllowPrivate: true });
      try {
        const saved = await saveSyslog(db, undefined, admin, named, {
          reach: reach("10.1.2.3"),
        });
        expect(saved).toMatchObject({
          configured: true,
          source: "administration",
          host: "logs.example.org",
          port: 6514,
        });
      } finally {
        await writeSettings(db, admin, { notifyAllowPrivate: false });
        await clearSyslog(db, admin);
      }
    });

    it("is not saved when the collector does not take the event", async () => {
      await expect(
        saveSyslog(db, undefined, admin, named, {
          reach: {
            resolve: () =>
              Promise.resolve([{ address: "203.0.113.10", family: 4 }]),
            send: () => Promise.reject(new Error("no route")),
          },
        }),
      ).rejects.toMatchObject({ code: "syslog_unreachable" });
      expect(await publicSyslog(db, undefined)).toMatchObject({
        configured: false,
      });
    });

    it("is saved once it took an event, then gets the trail's events", async () => {
      received.length = 0;
      await drain();
      const saved = await saveSyslog(db, undefined, admin, named, {
        ip: "192.0.2.20",
        reach: reach("203.0.113.10"),
      });
      expect(saved).toEqual({
        configured: true,
        source: "administration",
        host: "logs.example.org",
        port: 6514,
        ownAuthority: false,
        saved: true,
      });
      // The event sent to try it, before anything was saved.
      expect(received).toHaveLength(1);
      expect(received[0]).toContain('"detail":"syslog"');
      // Saving is on the trail, and the trail's events are queued from then.
      expect(await waiting()).toEqual(["settings_changed"]);
      await drain();
      await recordAuthEvent(db, { action: "account_locked" });
      expect(await waiting()).toEqual(["account_locked"]);
      await deliverSyslogEvent(
        db,
        undefined,
        {
          action: "account_locked",
          userId: null,
          actorId: null,
          method: null,
          detail: null,
          ip: null,
          occurredAt: new Date().toISOString(),
        },
        reach("203.0.113.10"),
      );
      expect(received).toHaveLength(2);
      await sendSyslogTest(db, undefined, admin, reach("203.0.113.10"));
      expect(received).toHaveLength(3);
      // Private networks closed again: a collector that now resolves to
      // one is no longer sent to.
      await expect(
        sendSyslogTest(db, undefined, admin, reach("10.1.2.3")),
      ).rejects.toMatchObject({ code: "invalid_syslog_target" });
    });

    it("gives way to the environment's, and is forgotten when cleared", async () => {
      expect(await publicSyslog(db, collector)).toMatchObject({
        configured: true,
        source: "environment",
        host: collector.host,
        saved: true,
      });
      await clearSyslog(db, admin, "192.0.2.20");
      expect(await publicSyslog(db, undefined)).toEqual({
        configured: false,
        saved: false,
      });
      await drain();
      await recordAuthEvent(db, { action: "account_locked" });
      expect(await waiting()).toEqual([]);
      await expect(sendSyslogTest(db, undefined, admin)).rejects.toMatchObject({
        code: "not_found",
      });
    });
  });

  it("carries the change trail's batches, which the trail then verifies against", async () => {
    received.length = 0;
    const author = (
      await db
        .insertInto("users")
        .values({ email: "trail-author@example.org", displayName: "Trail" })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;
    await pool.query(
      `insert into instance_settings (key, value, updated_by)
       values ('trailToCollector', 'true', $1)`,
      [author],
    );
    const ship = () =>
      shipTrail({ db, key: env.AUTH_ENCRYPTION_KEY, syslog: collector });
    const { rows } = await pool.query<{ id: string }>(
      "insert into audit_events (user_id, action) values ($1, 'update') returning id::text as id",
      [author],
    );
    const written = rows[0]?.id ?? "";
    const lines = () =>
      received.map((frame) => frame.slice(frame.indexOf(" ") + 1));
    // The whole trail goes; this event once no transaction of the cluster
    // open when it looked is still open.
    for (
      let tries = 0;
      tries < 100 && !lines().some((line) => line.includes(written));
      tries += 1
    ) {
      await ship();
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(lines().some((line) => line.includes(written))).toBe(true);
    for (const line of lines()) {
      expect(line).toMatch(/^<133>1 \S+ \S+ anygriddb - trail - \{/);
    }
    const report = await verifyTrail(
      db,
      env.AUTH_ENCRYPTION_KEY,
      lines().join("\n"),
    );
    expect(report.findings).toEqual([]);
    expect(report.matched).toBe(report.events);
    expect(report.batches).toBe(received.length);
  });
});
