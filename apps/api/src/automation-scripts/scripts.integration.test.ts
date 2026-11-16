/**
 * Scripts in automations as the queue runs them, against a real
 * database: what a script reads and writes is what its author may, in
 * its automation's base and nowhere else (ADR 0099).
 */
import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AppError,
  type AutomationAction,
  type AutomationStep,
  type AutomationTrigger,
} from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import type { TaskList } from "graphile-worker";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadBindings } from "../auth/access.js";
import { saveAutomation, setAutomationEnabled } from "../automations.js";
import { setTableAcl } from "../data/acl.js";
import { withAudit } from "../data/audit-context.js";
import { readPage } from "../data/rows.js";
import { insertBase, insertTable } from "../data/schema-ops.js";
import { readEnv } from "../env.js";
import { registry } from "../observability.js";
import { DiskStore } from "../files/index.js";
import { runJobs } from "../queue/run-once.test-helpers.js";
import { taskGroups } from "../queue/tasks.js";
import { recordingBus } from "../realtime/recording-bus.test-helpers.js";
import { createRows, findLiveTable, loadRowScope } from "../services/rows.js";
import { writeSettings } from "../settings.js";
import { createTestDatabase } from "../test-database.js";

const suffix = randomBytes(6).toString("hex");
const key = randomBytes(32);
const { bus } = recordingBus();
const meta = { source: "web" };

describe("scripts in automations", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let pool: pg.Pool;
  let tasks: TaskList;
  let owner = "";
  let editor = "";
  let ordersId = "";
  let logId = "";

  beforeAll(async () => {
    const created = await createTestDatabase("scripts");
    db = created.db;
    close = created.close;
    pool = new pg.Pool({ connectionString: created.url, max: 4 });
    pool.on("error", () => undefined);
    const people = await db
      .insertInto("users")
      .values([
        { email: `owner-${suffix}@example.com`, displayName: "Owner" },
        { email: `editor-${suffix}@example.com`, displayName: "Editor" },
      ])
      .returning("id")
      .execute();
    owner = people[0]?.id ?? "";
    editor = people[1]?.id ?? "";
    const baseId = (await insertBase(db, owner, { name: "Shop" })).id;
    ordersId = (
      await insertTable(db, owner, {
        baseId,
        name: "Orders",
        columns: [
          { name: "title", label: "Title", fieldType: "text" },
          { name: "seller", label: "Seller", fieldType: "text" },
          { name: "amount", label: "Amount", fieldType: "number" },
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
    // Another base the editor works in too: a script of the first one
    // must not reach it.
    const otherId = (await insertBase(db, owner, { name: "Payroll" })).id;
    await insertTable(db, owner, {
      baseId: otherId,
      name: "Salaries",
      columns: [{ name: "who", label: "Who", fieldType: "text" }],
    });
    await withAudit(db, { userId: owner, source: "web" }, (tx) =>
      tx
        .insertInto("roleBindings")
        .values([
          { userId: editor, role: "editor", scope: "base", scopeId: baseId },
          { userId: editor, role: "editor", scope: "base", scopeId: otherId },
        ])
        .execute(),
    );
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
  }, 120_000);

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

  async function addOrders(
    values: Array<Record<string, string | number>>,
  ): Promise<void> {
    await createRows(
      { db, bus, log: () => undefined },
      await scope(ordersId),
      values.map((row) => ({ values: row })),
      meta,
    );
  }

  function automation(
    author: string,
    name: string,
    trigger: AutomationTrigger,
    actions: AutomationAction[],
  ) {
    return saveAutomation(db, {
      tableId: ordersId,
      createdBy: author,
      name,
      enabled: true,
      trigger,
      actions,
    });
  }

  async function lastRun(automationId: string) {
    const runs = await db
      .selectFrom("automationRuns")
      .select(["status", "steps", "error"])
      .where("automationId", "=", automationId)
      .orderBy("startedAt", "desc")
      .execute();
    return runs[0];
  }

  const script = (code: string): AutomationStep => ({
    type: "run_script",
    code,
  });

  it("is refused while the instance runs no script", async () => {
    await expect(
      automation(owner, "Too early", { type: "row_created" }, [
        script("return 1;"),
      ]),
    ).rejects.toMatchObject({ code: "scripts_disabled" });
    // Inside a branch or a loop too.
    await expect(
      automation(owner, "Too early", { type: "row_created" }, [
        { type: "for_each", tableId: logId, limit: 1, actions: [script("1")] },
      ]),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("reads its row, writes records, and hands values to the next action", async () => {
    await writeSettings(db, owner, { automationScripts: true });
    const saved = await automation(owner, "Totals", { type: "row_created" }, [
      script(`
        console.log("row", input.record.fields.title, input.trigger);
        const page = await records.list("Orders", {
          filter: { conjunction: "and", conditions: [
            { column: "seller", op: "is", value: input.record.fields.seller },
          ] },
          sort: "-amount",
        });
        const total = page.records.reduce((sum, row) => sum + Number(row.fields.amount), 0);
        const made = await records.create("Log", { note: "seen " + input.values.title });
        await records.update("Log", made.id, { note: "seen " + input.values.title + " twice" });
        return { total, biggest: page.records[0].fields.title };
      `),
      {
        type: "update_record",
        values: { note: "{{script_total}} with {{script_biggest}}" },
      },
    ]);
    await addOrders([{ title: "A", seller: "alice", amount: 10 }]);
    await work();
    await addOrders([{ title: "B", seller: "alice", amount: 32 }]);
    await work();
    const notes = Object.fromEntries(
      (await rowsOf(ordersId)).map((row) => [row.title, row.note]),
    );
    expect(notes).toEqual({ A: "10 with A", B: "42 with B" });
    expect((await rowsOf(logId)).map((row) => row.note).sort()).toEqual([
      "seen A twice",
      "seen B twice",
    ]);
    const run = await lastRun(saved.id);
    expect(run?.status).toBe("success");
    expect(run?.steps).toEqual([
      { type: "1.run_script", ok: true, log: ["row B row_created"] },
      { type: "2.update_record", ok: true },
    ]);
    // On the trail under the automation, as its other writes are.
    const trail = await db
      .selectFrom("auditEvents")
      .select(["source", "userId"])
      .where("tableId", "=", logId)
      .where("action", "=", "insert")
      .execute();
    expect(trail.length).toBe(2);
    expect(new Set(trail.map((entry) => entry.source))).toEqual(
      new Set([`automation:${saved.id}`]),
    );
    expect(new Set(trail.map((entry) => entry.userId))).toEqual(
      new Set([owner]),
    );
    await setAutomationEnabled(db, owner, saved.id, false);
  });

  it("sees and changes only what its author may", async () => {
    await addOrders([{ title: "C", seller: "bob", amount: 500 }]);
    await work();
    // The editor sees alice's orders, and not what they are worth.
    await setTableAcl(db, owner, {
      tableId: ordersId,
      userId: editor,
      rowFilter: {
        conjunction: "and",
        conditions: [{ column: "seller", op: "is", value: "alice" }],
      },
      columns: [
        { column: "title", access: "write" },
        { column: "seller", access: "read" },
        { column: "note", access: "write" },
      ],
    });
    const bob = (await rowsOf(ordersId)).find((row) => row.title === "C");
    if (!bob) throw new Error("no row C");
    const saved = await automation(editor, "Probe", { type: "webhook" }, [
      script(`
        const refused = async (attempt) => {
          try { await attempt(); return "allowed"; } catch (error) { return error.message; }
        };
        const page = await records.list("Orders", { sort: "title" });
        return {
          titles: page.records.map((row) => row.fields.title).join(","),
          fields: Object.keys(page.records[0].fields).sort().join(","),
          other: await records.get("Orders", ${JSON.stringify(bob.id)}),
          update: await refused(() => records.update("Orders", ${JSON.stringify(bob.id)}, { note: "mine" })),
          remove: await refused(() => records.delete("Orders", ${JSON.stringify(bob.id)})),
          hidden: await refused(() => records.update("Orders", page.records[0].id, { amount: 1 })),
          readOnly: await refused(() => records.update("Orders", page.records[0].id, { seller: "eve" })),
          elsewhere: await refused(() => records.list("Salaries")),
          unknown: await refused(() => records.list("Orders", { nonsense: true })),
        };
      `),
      {
        type: "create_record",
        tableId: logId,
        values: {
          note: "{{script_titles}}|{{script_fields}}|{{script_other}}|{{script_update}}|{{script_remove}}|{{script_hidden}}|{{script_readOnly}}|{{script_elsewhere}}|{{script_unknown}}",
        },
      },
    ]);
    const { queueWebhookRun } = await import("../automations.js");
    expect(await queueWebhookRun(db, saved.webhookToken ?? "", {})).toBe(true);
    await work();
    const run = await lastRun(saved.id);
    expect(run?.status).toBe("success");
    const report = (await rowsOf(logId))
      .map((row) => String(row.note))
      .find((note) => note.startsWith("A,B|"));
    const [
      titles,
      fields,
      other,
      update,
      remove,
      hidden,
      readOnly,
      elsewhere,
      unknown,
    ] = (report ?? "").split("|");
    expect(titles).toBe("A,B");
    expect(fields).toBe("note,seller,title");
    expect(other).toBe("");
    for (const answer of [update, remove, hidden, readOnly]) {
      expect(answer).not.toBe("allowed");
      expect(answer).not.toBe("");
    }
    expect(elsewhere).toBe("Unknown table: Salaries");
    expect(unknown).toBe("Invalid input");
    const after = (await rowsOf(ordersId)).find((row) => row.title === "C");
    expect(after).toMatchObject({ seller: "bob", amount: "500", note: null });
    await setAutomationEnabled(db, editor, saved.id, false);
  });

  it("stops the run where a script fails, with what it logged", async () => {
    const saved = await automation(owner, "Broken", { type: "webhook" }, [
      script(`console.log("so far");\nthrow new Error("not today");`),
      { type: "create_record", tableId: logId, values: { note: "after" } },
    ]);
    const { queueWebhookRun } = await import("../automations.js");
    await queueWebhookRun(db, saved.webhookToken ?? "", {});
    await work();
    const run = await lastRun(saved.id);
    expect(run?.status).toBe("failed");
    expect(run?.error).toBe("Error: not today (line 2)");
    expect(run?.steps).toEqual([
      {
        type: "1.run_script",
        ok: false,
        error: "Error: not today (line 2)",
        log: ["so far"],
      },
    ]);
    expect((await rowsOf(logId)).map((row) => row.note)).not.toContain("after");
    // The operator's metrics count scripts by how each ended.
    const counted = await registry.getSingleMetricAsString(
      "anygriddb_automation_scripts_total",
    );
    expect(counted).toMatch(/outcome="success"\} [1-9]/);
    expect(counted).toMatch(/outcome="error"\} 1\b/);
    await setAutomationEnabled(db, owner, saved.id, false);
  });

  it("runs once per row of a loop, each with that row", async () => {
    const saved = await automation(owner, "Each", { type: "webhook" }, [
      {
        type: "for_each",
        tableId: ordersId,
        limit: 10,
        filter: {
          conjunction: "and",
          conditions: [{ column: "seller", op: "is", value: "alice" }],
        },
        actions: [
          script(
            `return { shout: input.record.fields.title.toLowerCase() + "!" };`,
          ),
          { type: "update_record", values: { note: "{{script_shout}}" } },
        ],
      },
    ]);
    const { queueWebhookRun } = await import("../automations.js");
    await queueWebhookRun(db, saved.webhookToken ?? "", {});
    await work();
    expect((await lastRun(saved.id))?.status).toBe("success");
    const notes = Object.fromEntries(
      (await rowsOf(ordersId)).map((row) => [row.title, row.note]),
    );
    expect(notes).toMatchObject({ A: "a!", B: "b!" });
    await setAutomationEnabled(db, owner, saved.id, false);
  });

  it("no longer runs once an administrator turned scripts off", async () => {
    const saved = await automation(owner, "Later", { type: "webhook" }, [
      script(`await records.create("Log", { note: "too late" });`),
    ]);
    await writeSettings(db, owner, { automationScripts: false });
    const { queueWebhookRun } = await import("../automations.js");
    await queueWebhookRun(db, saved.webhookToken ?? "", {});
    await work();
    const run = await lastRun(saved.id);
    expect(run?.status).toBe("failed");
    expect(run?.error).toBe("Scripts disabled");
    expect((await rowsOf(logId)).map((row) => row.note)).not.toContain(
      "too late",
    );
  });
});
