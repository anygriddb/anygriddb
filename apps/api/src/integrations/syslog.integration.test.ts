/**
 * Sign-in events to a syslog collector (ADR 0084), against a real
 * database and queue: an event the collectors get is queued when the
 * process has a collector, delivered by the worker over verified TLS, and
 * rolled back with the transaction that made it.
 */
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
import { watchSyslog } from "./syslog.js";

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
});
