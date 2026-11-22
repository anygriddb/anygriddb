/**
 * A burst past an automation's limit runs late rather than never: every
 * row gets its run, no minute starts more than the limit, no action runs
 * twice, and a run that waited a day is dropped and said so.
 */
import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AutomationAction, AutomationTrigger } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import type { TaskList } from "graphile-worker";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadBindings } from "./auth/access.js";
import { reserveMinute, RUNS_PER_MINUTE, startRun } from "./automation-pace.js";
import {
  type AutomationDeps,
  runAutomation,
  runDueSchedules,
  runQueuedAutomation,
  saveAutomation,
  setAutomationEnabled,
} from "./automations.js";
import { insertBase, insertTable } from "./data/schema-ops.js";
import { readEnv } from "./env.js";
import { DiskStore } from "./files/index.js";
import { TASKS } from "./queue/jobs.js";
import { runJobs } from "./queue/run-once.test-helpers.js";
import { taskGroups } from "./queue/tasks.js";
import { recordingBus } from "./realtime/recording-bus.test-helpers.js";
import { createRows, findLiveTable, loadRowScope } from "./services/rows.js";
import { createTestDatabase } from "./test-database.js";

const suffix = randomBytes(6).toString("hex");
const { bus } = recordingBus();

describe("an automation past its limit of runs", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let pool: pg.Pool;
  let tasks: TaskList;
  let deps: AutomationDeps;
  let owner = "";
  let sourceId = "";
  let logId = "";
  let now = new Date();
  const made: string[] = [];

  beforeAll(async () => {
    const created = await createTestDatabase("pace");
    db = created.db;
    close = created.close;
    pool = new pg.Pool({ connectionString: created.url, max: 8 });
    pool.on("error", () => undefined);
    owner = (
      await db
        .insertInto("users")
        .values({ email: `pace-${suffix}@example.com`, displayName: "Owner" })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;
    const baseId = (await insertBase(db, owner, { name: "Pace" })).id;
    sourceId = (
      await insertTable(db, owner, {
        baseId,
        name: "Source",
        columns: [{ name: "name", label: "Name", fieldType: "text" }],
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
      AUTH_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    });
    deps = {
      db,
      bus,
      smtp: {},
      webOrigin: "https://grid.example.org",
      log: () => undefined,
      clock: () => now,
    };
    const groups = taskGroups({
      db,
      bus,
      env,
      files: new DiskStore(await mkdtemp(join(tmpdir(), "anygriddb-files-"))),
      log: () => undefined,
    });
    tasks = {
      ...(Object.assign({}, ...groups.map((group) => group.tasks)) as TaskList),
      // The queue's own task, on the clock this test moves.
      [TASKS.automationRun]: async (payload) => {
        await runQueuedAutomation(
          deps,
          payload as Parameters<typeof runQueuedAutomation>[1],
        );
      },
    };
  });

  beforeEach(async () => {
    // Ahead of the real clock: a job set for a later minute of this one
    // waits until the test moves to that minute.
    now = new Date(Date.now() + 3_600_000);
    await pool.query(`delete from graphile_worker._private_jobs`);
    // Each test's automation alone reacts to the rows it adds.
    for (const id of made.splice(0)) {
      await setAutomationEnabled(db, owner, id, false);
    }
    await db.deleteFrom("notifications").execute();
  });

  afterAll(async () => {
    await pool.end();
    await close?.();
  });

  async function automation(
    trigger: AutomationTrigger = { type: "row_created" },
    actions: AutomationAction[] = [
      {
        type: "create_record",
        tableId: logId,
        values: { note: "{{record_id}}" },
      },
    ],
  ) {
    const saved = await saveAutomation(db, {
      tableId: sourceId,
      createdBy: owner,
      name: "Paced",
      enabled: true,
      trigger,
      actions,
    });
    made.push(saved.id);
    return saved;
  }

  async function addRows(count: number, label: string) {
    const table = await findLiveTable(db, sourceId);
    if (!table) throw new Error("no table");
    const scope = await loadRowScope(
      db,
      { userId: owner, bindings: await loadBindings(db, owner) },
      table,
    );
    for (let at = 0; at < count; at += 500) {
      await createRows(
        { db, bus, log: () => undefined },
        scope,
        Array.from({ length: Math.min(500, count - at) }, (_, index) => ({
          values: { name: `${label}-${String(at + index)}` },
        })),
        { source: "web" },
      );
    }
  }

  async function logNotes(): Promise<string[]> {
    const table = await db
      .selectFrom("dataTables")
      .select("physicalName")
      .where("id", "=", logId)
      .executeTakeFirstOrThrow();
    const { rows } = await pool.query<{ note: string }>(
      `select note from "${table.physicalName}"`,
    );
    return rows.map((row) => row.note);
  }

  const waiting = async () =>
    Number(
      (
        await pool.query<{ count: string }>(
          `select count(*) from graphile_worker._private_jobs`,
        )
      ).rows[0]?.count,
    );

  /** Moves the clock a minute on, and wakes the jobs that minute holds. */
  async function moveOn() {
    now = new Date(now.getTime() + 60_000);
    const end = new Date((Math.floor(now.getTime() / 60_000) + 1) * 60_000);
    await pool.query(
      `update graphile_worker._private_jobs set run_at = now() where run_at < $1`,
      [end.toISOString()],
    );
  }

  /** Runs every job, on two workers at once, minute after minute. */
  async function drain(limit = 12) {
    for (let minute = 0; minute < limit; minute += 1) {
      await Promise.all([runJobs(pool, tasks), runJobs(pool, tasks)]);
      if ((await waiting()) === 0) return;
      await moveOn();
    }
    throw new Error("jobs still waiting");
  }

  async function runsOf(id: string) {
    return db
      .selectFrom("automationRuns")
      .select(["status", "error", "startedAt", "rowId"])
      .where("automationId", "=", id)
      .execute();
  }

  function perMinute(runs: ReadonlyArray<{ startedAt: Date }>): number[] {
    const counts = new Map<number, number>();
    for (const run of runs) {
      const minute = Math.floor(run.startedAt.getTime() / 60_000);
      counts.set(minute, (counts.get(minute) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, count]) => count);
  }

  it("gives 1,000 rows 1,000 runs, 300 a minute, none twice", async () => {
    const saved = await automation();
    await addRows(1_000, "burst");
    await drain();
    const runs = await runsOf(saved.id);
    expect(runs.filter((run) => run.status === "success")).toHaveLength(1_000);
    expect(runs.filter((run) => run.status !== "success")).toEqual([]);
    expect(new Set(runs.map((run) => run.rowId)).size).toBe(1_000);
    const minutes = perMinute(runs);
    expect(Math.max(...minutes)).toBeLessThanOrEqual(RUNS_PER_MINUTE);
    expect(minutes.reduce((sum, count) => sum + count, 0)).toBe(1_000);
    const notes = await logNotes();
    expect(new Set(notes).size).toBe(notes.length);
    expect(
      notes.filter((note) => runs.some((run) => run.rowId === note)),
    ).toHaveLength(1_000);
  }, 240_000);

  it("holds one count across concurrent workers", async () => {
    const saved = await automation();
    const started = await Promise.all(
      Array.from({ length: 400 }, () => startRun(db, saved.id, now)),
    );
    expect(started.filter(Boolean)).toHaveLength(RUNS_PER_MINUTE);
    const given = await Promise.all(
      Array.from({ length: 700 }, () => reserveMinute(db, saved.id, now)),
    );
    const byMinute = new Map<number, number>();
    for (const place of given) {
      if (!place) throw new Error("no place");
      const minute = Math.floor(place.runAt.getTime() / 60_000);
      byMinute.set(minute, (byMinute.get(minute) ?? 0) + 1);
    }
    expect([...byMinute.values()].sort((a, b) => b - a)).toEqual([
      300, 300, 100,
    ]);
  });

  it("does not let runs that wait hold the limit shut", async () => {
    const saved = await automation();
    await addRows(350, "first");
    await drain();
    await moveOn();
    await addRows(10, "later");
    await drain();
    const runs = await runsOf(saved.id);
    expect(runs.filter((run) => run.status === "success")).toHaveLength(360);
  }, 120_000);

  it("drops a run past a day of waiting, and tells its author once", async () => {
    const saved = await automation();
    const minute = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
    await pool.query(
      `insert into automation_run_pace
         (automation_id, started_minute, started, reserved_minute, reserved)
       values ($1, $2, 0, $3, 300)`,
      [
        saved.id,
        minute.toISOString(),
        new Date(minute.getTime() + 1_439 * 60_000).toISOString(),
      ],
    );
    await addRows(3, "too-late");
    await Promise.all([runJobs(pool, tasks), runJobs(pool, tasks)]);
    const runs = await runsOf(saved.id);
    expect(runs.map((run) => [run.status, run.error])).toEqual([
      ["skipped", "Delayed too long"],
      ["skipped", "Delayed too long"],
      ["skipped", "Delayed too long"],
    ]);
    const notes = await logNotes();
    expect(
      notes.filter((note) => runs.some((run) => run.rowId === note)),
    ).toEqual([]);
    const told = await db
      .selectFrom("notifications")
      .select(["userId", "kind", "data"])
      .execute();
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({
      userId: owner,
      kind: "automation",
      data: { code: "runs_dropped", name: "Paced" },
    });
  });

  it("drops a run that waited in the queue for more than a day", async () => {
    const saved = await automation();
    await runQueuedAutomation(deps, {
      automationId: saved.id,
      values: {},
      queuedAt: new Date(now.getTime() - 25 * 3_600_000).toISOString(),
    });
    expect((await runsOf(saved.id)).map((run) => run.error)).toEqual([
      "Delayed too long",
    ]);
  });

  it("still runs one that waited just under a day", async () => {
    const saved = await automation({ type: "webhook" }, [
      { type: "create_record", tableId: logId, values: { note: "kept" } },
    ]);
    await runQueuedAutomation(deps, {
      automationId: saved.id,
      values: {},
      queuedAt: new Date(now.getTime() - 23 * 3_600_000).toISOString(),
    });
    expect((await runsOf(saved.id)).map((run) => run.status)).toEqual([
      "success",
    ]);
  });

  it("gives back the minutes of waiting runs when switched off", async () => {
    const saved = await automation();
    for (let index = 0; index < RUNS_PER_MINUTE * 2 + 1; index += 1) {
      await reserveMinute(db, saved.id, now);
    }
    const before = await reserveMinute(db, saved.id, now);
    expect(before?.due).toBe(false);
    await setAutomationEnabled(db, owner, saved.id, false);
    await setAutomationEnabled(db, owner, saved.id, true);
    expect((await reserveMinute(db, saved.id, now))?.due).toBe(true);
  });

  it("answers a press of a button at once when the minute is full", async () => {
    const saved = await automation();
    const row = await db
      .selectFrom("automations")
      .selectAll()
      .where("id", "=", saved.id)
      .executeTakeFirstOrThrow();
    await Promise.all(
      Array.from({ length: RUNS_PER_MINUTE }, () =>
        startRun(db, saved.id, now),
      ),
    );
    await expect(
      runAutomation(deps, row, { depth: 0, trigger: "button" }),
    ).resolves.toEqual({ status: "skipped", error: "Rate limit" });
  });

  it("makes a schedule that finds its minute full wait for the next", async () => {
    const saved = await automation(
      { type: "schedule", every: "hour", at: "09:00", timeZone: "UTC" },
      [{ type: "create_record", tableId: logId, values: { note: "tick" } }],
    );
    await db
      .updateTable("automations")
      .set({ nextRunAt: new Date(Date.now() - 1_000) })
      .where("id", "=", saved.id)
      .execute();
    await Promise.all(
      Array.from({ length: RUNS_PER_MINUTE }, () =>
        startRun(db, saved.id, now),
      ),
    );
    await Promise.all(
      Array.from({ length: RUNS_PER_MINUTE }, () =>
        reserveMinute(db, saved.id, now),
      ),
    );
    expect(await runDueSchedules(deps)).toBe(1);
    expect(await runsOf(saved.id)).toEqual([]);
    expect(await waiting()).toBe(1);
    await moveOn();
    await drain();
    expect((await runsOf(saved.id)).map((run) => run.status)).toEqual([
      "success",
    ]);
  });
});
