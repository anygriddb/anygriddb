/**
 * Automations as the queue runs them, against a real database: branches,
 * loops, deleting a row, a deleted row's trigger, and an incoming webhook.
 */
import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AutomationAction, AutomationTrigger } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import type { TaskList } from "graphile-worker";
import { runJobs } from "./queue/run-once.test-helpers.js";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadBindings } from "./auth/access.js";
import {
  queueWebhookRun,
  renewAutomationWebhook,
  saveAutomation,
  setAutomationEnabled,
} from "./automations.js";
import { readPage } from "./data/rows.js";
import { insertBase, insertTable } from "./data/schema-ops.js";
import { readEnv } from "./env.js";
import { DiskStore } from "./files/index.js";
import { taskGroups } from "./queue/tasks.js";
import { recordingBus } from "./realtime/recording-bus.test-helpers.js";
import {
  createRows,
  findLiveTable,
  loadRowScope,
  updateRows,
} from "./services/rows.js";
import { createTestDatabase } from "./test-database.js";

const suffix = randomBytes(6).toString("hex");
const key = randomBytes(32);
const { bus } = recordingBus();
const meta = { source: "web" };

describe("automations run by the queue", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let pool: pg.Pool;
  let tasks: TaskList;
  let owner = "";
  let tasksId = "";
  let logId = "";

  beforeAll(async () => {
    const created = await createTestDatabase("automations");
    db = created.db;
    close = created.close;
    pool = new pg.Pool({ connectionString: created.url, max: 4 });
    pool.on("error", () => undefined);
    const person = await db
      .insertInto("users")
      .values({ email: `owner-${suffix}@example.com`, displayName: "Owner" })
      .returning("id")
      .executeTakeFirstOrThrow();
    owner = person.id;
    const baseId = (await insertBase(db, owner, { name: "Flows" })).id;
    tasksId = (
      await insertTable(db, owner, {
        baseId,
        name: "Tasks",
        columns: [
          { name: "name", label: "Name", fieldType: "text" },
          { name: "status", label: "Status", fieldType: "text" },
          { name: "note", label: "Note", fieldType: "text" },
        ],
      })
    ).id;
    logId = (
      await insertTable(db, owner, {
        baseId,
        name: "Log",
        columns: [{ name: "note", label: "Note", fieldType: "text" }],
      })
    ).id;
    const env = readEnv({
      DATABASE_URL: created.url,
      AUTH_ENCRYPTION_KEY: key.toString("base64"),
    });
    const groups = taskGroups({
      db,
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

  /** Runs every job waiting, and those they queue. */
  async function work(): Promise<void> {
    await runJobs(pool, tasks);
  }

  async function scope(tableId: string) {
    const table = await findLiveTable(db, tableId);
    if (!table) throw new Error("no table");
    return loadRowScope(
      db,
      { userId: owner, bindings: await loadBindings(db, owner) },
      table,
    );
  }

  async function rowsOf(tableId: string) {
    const page = await readPage(
      db,
      (await scope(tableId)).engine,
      { limit: 100, timeZone: "UTC", me: owner },
      { total: false },
    );
    return page.rows;
  }

  async function automation(
    name: string,
    trigger: AutomationTrigger,
    actions: AutomationAction[],
  ) {
    return saveAutomation(db, {
      tableId: tasksId,
      createdBy: owner,
      name,
      enabled: true,
      trigger,
      actions,
    });
  }

  async function stepsOf(automationId: string) {
    const runs = await db
      .selectFrom("automationRuns")
      .select(["status", "steps", "error"])
      .where("automationId", "=", automationId)
      .orderBy("startedAt")
      .execute();
    return runs;
  }

  const statusIs = (value: string) => ({
    conjunction: "and" as const,
    conditions: [{ column: "status", op: "is" as const, value }],
  });

  it("takes the branch the row's values pick", async () => {
    const saved = await automation("Triage", { type: "row_created" }, [
      {
        type: "branch",
        when: statusIs("done"),
        then: [{ type: "update_record", values: { note: "closed" } }],
        otherwise: [
          { type: "update_record", values: { note: "open {{name}}" } },
        ],
      },
    ]);
    expect(saved.webhookToken).toBeUndefined();
    await createRows(
      { db, bus, log: () => undefined },
      await scope(tasksId),
      [
        { values: { name: "A", status: "done" } },
        { values: { name: "B", status: "todo" } },
      ],
      meta,
    );
    await work();
    const notes = Object.fromEntries(
      (await rowsOf(tasksId)).map((row) => [row.name, row.note]),
    );
    expect(notes).toEqual({ A: "closed", B: "open B" });
    const runs = await stepsOf(saved.id);
    expect(runs.map((run) => run.status)).toEqual(["success", "success"]);
    expect(runs.flatMap((run) => run.steps?.map((step) => step.type))).toEqual(
      expect.arrayContaining([
        "1.branch:then",
        "1.branch:otherwise",
        "1.1.update_record",
      ]),
    );
    await setAutomationEnabled(db, saved.id, false);
  });

  it("deletes a row, and a deleted row's trigger reads its values", async () => {
    const remover = await automation(
      "Remove obsolete",
      { type: "row_updated", columns: ["status"] },
      [
        {
          type: "branch",
          when: statusIs("obsolete"),
          then: [{ type: "delete_record" }],
        },
      ],
    );
    const mourner = await automation("Keep a trace", { type: "row_deleted" }, [
      {
        type: "create_record",
        tableId: logId,
        values: { note: "gone {{name}} {{record_id}}" },
      },
    ]);
    const rows = await rowsOf(tasksId);
    const target = rows.find((row) => row.name === "B");
    if (!target) throw new Error("no row B");
    await updateRows(
      { db, bus, log: () => undefined },
      await scope(tasksId),
      [{ rowId: target.id, values: { status: "obsolete" } }],
      meta,
    );
    await work();
    expect((await rowsOf(tasksId)).map((row) => row.name)).toEqual(["A"]);
    expect((await rowsOf(logId)).map((row) => row.note)).toEqual([
      `gone B ${target.id}`,
    ]);
    expect((await stepsOf(remover.id)).at(-1)?.steps).toEqual([
      { type: "1.branch:then", ok: true },
      { type: "1.1.delete_record", ok: true },
    ]);
    expect((await stepsOf(mourner.id)).map((run) => run.status)).toEqual([
      "success",
    ]);
    await setAutomationEnabled(db, remover.id, false);
    await setAutomationEnabled(db, mourner.id, false);
  });

  it("loops over the rows a filter keeps, from a webhook call", async () => {
    await createRows(
      { db, bus, log: () => undefined },
      await scope(tasksId),
      [
        { values: { name: "C", status: "done" } },
        { values: { name: "D", status: "todo" } },
      ],
      meta,
    );
    await work();
    const saved = await automation("Inbound", { type: "webhook" }, [
      {
        type: "for_each",
        tableId: tasksId,
        filter: statusIs("done"),
        limit: 10,
        actions: [
          {
            type: "update_record",
            values: { note: "{{body_who}} saw {{name}}" },
          },
          {
            type: "create_record",
            tableId: logId,
            values: { note: "loop {{name}} for {{body_order_id}}" },
          },
        ],
      },
    ]);
    const token = saved.webhookToken ?? "";
    expect(token).toMatch(/^aghook_[A-Za-z0-9_-]{43}$/);
    // The token is not kept: only its hash.
    const stored = await db
      .selectFrom("automations")
      .select("webhookTokenHash")
      .where("id", "=", saved.id)
      .executeTakeFirstOrThrow();
    expect(stored.webhookTokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.webhookTokenHash).not.toContain(token);

    expect(await queueWebhookRun(db, `aghook_${"x".repeat(43)}`, {})).toBe(
      false,
    );
    expect(await queueWebhookRun(db, "not-a-token", {})).toBe(false);
    expect(
      await queueWebhookRun(db, token, { who: "Ada", order: { id: 42 } }),
    ).toBe(true);
    await work();
    const notes = Object.fromEntries(
      (await rowsOf(tasksId)).map((row) => [row.name, row.note]),
    );
    expect(notes).toMatchObject({ A: "Ada saw A", C: "Ada saw C" });
    expect(notes.D).not.toBe("Ada saw D");
    expect(
      (await rowsOf(logId))
        .map((row) => row.note)
        .filter((note) => String(note).startsWith("loop")),
    ).toEqual(expect.arrayContaining(["loop A for 42", "loop C for 42"]));
    const [run] = await stepsOf(saved.id);
    expect(run?.status).toBe("success");
    expect(run?.steps?.[0]).toEqual({ type: "1.for_each:2", ok: true });

    // Saving again keeps the address; renewing it stops the old one.
    const again = await saveAutomation(db, {
      id: saved.id,
      tableId: tasksId,
      createdBy: owner,
      name: "Inbound",
      enabled: true,
      trigger: { type: "webhook" },
      actions: [{ type: "notify", users: [owner], message: "hi" }],
    });
    expect(again.webhookToken).toBeUndefined();
    const renewed = await renewAutomationWebhook(db, saved.id);
    expect(await queueWebhookRun(db, token, {})).toBe(false);
    expect(await queueWebhookRun(db, renewed, {})).toBe(true);
    // A disabled automation answers as an unknown address does.
    await setAutomationEnabled(db, saved.id, false);
    expect(await queueWebhookRun(db, renewed, {})).toBe(false);
  });
});
