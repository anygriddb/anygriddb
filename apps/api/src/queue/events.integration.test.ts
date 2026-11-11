import { randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { sql } from "kysely";
import { runOnce, type TaskList } from "graphile-worker";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encryptSecret } from "../auth/crypto.js";
import { withAudit } from "../data/audit-context.js";
import { insertBase, insertTable } from "../data/schema-ops.js";
import { readEnv } from "../env.js";
import {
  createRows,
  findLiveTable,
  insertNativeBatch,
  loadRowScope,
} from "../services/rows.js";
import { loadBindings } from "../auth/access.js";
import { TASKS } from "./jobs.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiskStore } from "../files/index.js";
import { createTestDatabase } from "../test-database.js";
import { recordingBus } from "../realtime/recording-bus.test-helpers.js";
import { taskGroups } from "./tasks.js";

const suffix = randomBytes(6).toString("hex");
const key = randomBytes(32);

const { bus } = recordingBus();

type QueuedJob = { task_identifier: string; payload: unknown; key: string };

describe("row events in graphile-worker", () => {
  let database: Database;
  let close: (() => Promise<void>) | undefined;
  let url = "";
  let pool: pg.Pool;
  let tasks: TaskList;
  let owner = "";
  let tableId = "";

  /** Jobs waiting in graphile-worker, with their payloads. */
  async function queued(task?: string): Promise<QueuedJob[]> {
    const result = await pool.query<QueuedJob>(
      `select j.task_identifier, p.payload, j.key
         from graphile_worker.jobs j
         join graphile_worker._private_jobs p on p.id = j.id
        where $1::text is null or j.task_identifier = $1::text`,
      [task ?? null],
    );
    return result.rows;
  }

  beforeAll(async () => {
    const created = await createTestDatabase("events");
    url = created.url;
    database = created.db;
    close = created.close;
    pool = new pg.Pool({ connectionString: url, max: 4 });
    pool.on("error", () => undefined);

    const person = await database
      .insertInto("users")
      .values({ email: `owner-${suffix}@example.com`, displayName: "Owner" })
      .returning("id")
      .executeTakeFirst();
    owner = person?.id ?? "";
    const baseId = (await insertBase(database, owner, { name: "Events" })).id;
    tableId = (
      await insertTable(database, owner, {
        baseId,
        name: "Tasks",
        columns: [{ name: "title", label: "Title", fieldType: "text" }],
      })
    ).id;
    const sealed = encryptSecret("secret", key);
    await database
      .insertInto("webhooks")
      .values({
        tableId,
        kind: "http",
        // A private address: every attempt fails, and is scheduled again.
        target: "https://127.0.0.1/hook",
        secretCiphertext: sealed.ciphertext,
        secretNonce: sealed.nonce,
        events: ["insert", "update", "delete", "import"],
        createdBy: owner,
      })
      .execute();

    const env = readEnv({
      DATABASE_URL: url,
      AUTH_ENCRYPTION_KEY: key.toString("base64"),
    });
    const groups = taskGroups({
      db: database,
      bus,
      env,
      files: new DiskStore(await mkdtemp(join(tmpdir(), "anygriddb-files-"))),
      log: () => undefined,
    });
    tasks = Object.assign(
      {},
      ...groups.map((group) => group.tasks),
    ) as TaskList;
  });

  afterAll(async () => {
    await pool.end();
    await close?.();
  });

  async function work(): Promise<void> {
    await runOnce({ pgPool: pool, taskList: tasks });
  }

  async function scope(id: string = tableId) {
    const table = await findLiveTable(database, id);
    if (!table) throw new Error("no table");
    return loadRowScope(
      database,
      { userId: owner, bindings: await loadBindings(database, owner) },
      table,
    );
  }

  it("queues one event job per committed write, and nothing for a rolled back one", async () => {
    await pool.query("delete from graphile_worker._private_jobs");
    const table = await scope();
    await expect(
      withAudit(
        database,
        { userId: owner, tableId, source: "web", events: { depth: 0 } },
        async (tx) => {
          await sql
            .raw(
              `insert into "${table.table.physicalName}" ("title") values ('lost')`,
            )
            .execute(tx);
          throw new Error("crash in the middle of the write");
        },
      ),
    ).rejects.toThrow("crash in the middle of the write");
    expect(await queued()).toEqual([]);

    const ids = await createRows(
      { db: database, bus, log: () => undefined },
      table,
      [{ values: { title: "A" } }, { values: { title: "B" } }],
      { source: "web" },
    );
    expect(ids).toHaveLength(2);
    const events = await queued(TASKS.rowEvents);
    expect(events).toHaveLength(1);
  });

  it("delivers each row of the transaction to the webhook, once", async () => {
    await work();
    const deliveries = await database
      .selectFrom("webhookDeliveries")
      .selectAll()
      .orderBy("createdAt", "asc")
      .execute();
    expect(deliveries).toHaveLength(2);
    for (const delivery of deliveries) {
      // The attempt failed against a private address: retried later.
      expect(delivery.status).toBe("pending");
      expect(delivery.attempts).toBe(1);
      expect(delivery.event).toBe("insert");
    }
    const next = await queued(TASKS.webhookAttempt);
    expect(next.map((job) => job.key).sort()).toEqual(
      deliveries.map((delivery) => `webhook:${delivery.id}:1`).sort(),
    );
    // Nothing else is left to run: the event and its consumers are done.
    expect(
      (await queued()).filter(
        (job) => job.task_identifier !== TASKS.webhookAttempt,
      ),
    ).toEqual([]);
  });

  it("sends one import event with the count of what committed", async () => {
    await pool.query("delete from graphile_worker._private_jobs");
    await database.deleteFrom("webhookDeliveries").execute();
    const table = await scope();
    for (const count of [500, 1000, 1200]) {
      await insertNativeBatch(
        database,
        table.engine,
        {
          userId: owner,
          tableId,
          physicalName: table.table.physicalName,
          baseId: table.table.baseId,
          reason: null,
          source: "import",
          events: {
            summary: {
              event: { tableId, event: "import", count, actorId: owner },
              key: "test-import",
              delayMs: 0,
            },
          },
        },
        [{ title: `batch ${String(count)}` }],
      );
    }
    const summaries = await queued(TASKS.rowEvents);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.payload).toMatchObject({
      event: { event: "import", count: 1200 },
    });
    await work();
    const deliveries = await database
      .selectFrom("webhookDeliveries")
      .selectAll()
      .where("event", "=", "import")
      .execute();
    expect(deliveries).toHaveLength(1);
  });

  it("hands a row event only to the consumers its table has", async () => {
    await pool.query("delete from graphile_worker._private_jobs");
    const baseId = (await scope()).table.baseId;
    const quietId = (
      await insertTable(database, owner, {
        baseId,
        name: "Quiet",
        columns: [{ name: "title", label: "Title", fieldType: "text" }],
      })
    ).id;
    const deps = { db: database, bus, log: () => undefined };
    await createRows(
      deps,
      await scope(quietId),
      [{ values: { title: "A" } }, { values: { title: "B" } }],
      { source: "web" },
    );
    await createRows(deps, await scope(), [{ values: { title: "C" } }], {
      source: "web",
    });
    expect(await queued(TASKS.rowEvents)).toHaveLength(2);
    // The events alone, so the jobs they queue stay to be counted.
    await runOnce({
      pgPool: pool,
      taskList: { [TASKS.rowEvents]: tasks[TASKS.rowEvents] },
    });
    // No webhook, no automation, no user field on Quiet: nothing for its
    // two rows. The other table has a webhook and nothing else.
    // (The worker may still be marking its last event done.)
    const left = (await queued()).filter(
      (job) => job.task_identifier !== TASKS.rowEvents,
    );
    expect(left.map((job) => job.task_identifier)).toEqual([
      TASKS.webhooksEvent,
    ]);
    expect(left[0]?.payload).toMatchObject({
      event: { tableId, event: "insert" },
    });
  });
});
