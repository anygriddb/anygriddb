/**
 * Jobs, the trash, and job authors against a real database: the behavior
 * the unit tests used to check through fakes of the query builder.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { AppError } from "@anygriddb/core";
import type { Database, JobRow } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { authorTable } from "../job-runners.js";
import { runJob } from "../jobs.js";
import { mkdtemp, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiskStore } from "../files/index.js";
import { sweepOrphanFiles } from "../files/sweep.js";
import { exportKey } from "../storage.js";
import { recordingBus } from "../realtime/recording-bus.test-helpers.js";
import { createTestDatabase } from "../test-database.js";
import { runRows, withAudit } from "./audit-context.js";
import {
  dropStagedImport,
  loadStagedImport,
  stageImport,
} from "./import-commit.js";
import { purgeStagedUploads } from "./staged-uploads.js";
import { insertBase, insertTable } from "./schema-ops.js";
import {
  purgeItem,
  restoreColumn,
  trashBase,
  trashColumn,
  trashTable,
} from "./trash.js";
import {
  createView,
  listViews,
  loadView,
  trashView,
  updateView,
} from "./views.js";
import { loadEngine } from "./engine.js";

const suffix = randomBytes(6).toString("hex");

describe("jobs, trash, and authors", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let owner = "";
  let viewer = "";

  beforeAll(async () => {
    const created = await createTestDatabase("lifecycle");
    db = created.db;
    close = created.close;
    const people = await db
      .insertInto("users")
      .values([
        { email: `owner-${suffix}@example.com`, displayName: "Owner" },
        { email: `viewer-${suffix}@example.com`, displayName: "Viewer" },
      ])
      .returning("id")
      .execute();
    owner = people[0]?.id ?? "";
    viewer = people[1]?.id ?? "";
  });

  afterAll(async () => {
    await close?.();
  });

  async function runningJob(): Promise<JobRow> {
    const job = await db
      .insertInto("jobs")
      .values({
        kind: "export",
        userId: owner,
        input: {},
        status: "running",
        attempts: 1,
        startedAt: new Date(),
        leaseUntil: new Date(Date.now() + 60_000),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return job;
  }

  const live = new AbortController().signal;

  describe("runJob", () => {
    it("records progress and finishes with the runner's result", async () => {
      const job = await runningJob();
      const { bus, published } = recordingBus();
      const finished = await runJob(
        { db, bus, log: vi.fn() },
        job,
        async ({ progress }) => {
          await progress(0, 2);
          await progress(1);
          return { result: { rows: 2 } };
        },
        live,
      );
      expect(finished).toMatchObject({
        status: "done",
        result: { rows: 2 },
        progressDone: 2,
        progressTotal: 2,
      });
      expect(published.at(0)).toMatchObject({
        channel: `grid:${owner}`,
        message: { type: "job", jobId: job.id, status: "running", total: 2 },
      });
      expect(published.at(-1)?.message).toMatchObject({ status: "done" });
    });

    it("stops at the next report once the author cancelled", async () => {
      const job = await runningJob();
      await db
        .updateTable("jobs")
        .set({ cancelRequested: true })
        .where("id", "=", job.id)
        .execute();
      const { bus } = recordingBus();
      const finished = await runJob(
        { db, bus, log: vi.fn() },
        job,
        async ({ progress }) => {
          await progress(1, 10);
          return {};
        },
        live,
      );
      expect(finished).toMatchObject({ status: "cancelled", error: null });
    });

    it("fails with a public message, and hides internal errors", async () => {
      const log = vi.fn();
      const { bus } = recordingBus();
      const first = await runJob(
        { db, bus, log },
        await runningJob(),
        () => Promise.reject(new AppError("too_many_rows")),
        live,
      );
      expect(first).toMatchObject({
        status: "failed",
        error: "Too many rows",
        errorCode: "too_many_rows",
      });
      expect(log).not.toHaveBeenCalled();
      const second = await runJob(
        { db, bus, log },
        await runningJob(),
        () => Promise.reject(new Error("connect ECONNREFUSED 10.0.0.3:5432")),
        live,
      );
      expect(second).toMatchObject({
        error: "Internal error",
        errorCode: "internal_error",
      });
      expect(log).toHaveBeenCalledOnce();
    });

    it("marks a job interrupted when the worker stops", async () => {
      const stopping = new AbortController();
      stopping.abort();
      const { bus } = recordingBus();
      const finished = await runJob(
        { db, bus, log: vi.fn() },
        await runningJob(),
        async ({ progress }) => {
          await progress(1, 5);
          return {};
        },
        stopping.signal,
      );
      expect(finished).toMatchObject({
        status: "failed",
        error: "Interrupted",
      });
    });

    it("refuses a kind without a runner", async () => {
      const { bus } = recordingBus();
      const finished = await runJob(
        { db, bus, log: vi.fn() },
        await runningJob(),
        undefined,
        live,
      );
      expect(finished).toMatchObject({ error: "Invalid job" });
    });
  });

  describe("identifiers", () => {
    it("gives catalog and user rows UUIDv7 ids that sort by creation", async () => {
      const first = (await insertBase(db, owner, { name: "First" })).id;
      const second = (await insertBase(db, owner, { name: "Second" })).id;
      const table = await insertTable(db, owner, {
        baseId: second,
        name: "Items",
        columns: [{ name: "title", label: "Title", fieldType: "text" }],
      });
      const version = (id: string) => id.charAt(14);
      expect([first, second, table.id].map(version)).toEqual(["7", "7", "7"]);
      // Time-ordered: the 48-bit millisecond prefix never goes back.
      expect(first.slice(0, 13) <= second.slice(0, 13)).toBe(true);
      const physical = await db
        .selectFrom("dataTables")
        .select("physicalName")
        .where("id", "=", table.id)
        .executeTakeFirstOrThrow();
      const row = await withAudit(
        db,
        { userId: owner, tableId: table.id, source: "web" },
        (tx) =>
          runRows(tx, {
            text: `insert into "${physical.physicalName}" ("title") values ('a') returning "id"`,
            values: [],
          }),
      );
      expect(version(String(row[0]?.id))).toBe("7");
    });
  });

  describe("staged uploads", () => {
    it("returns an upload to its owner only, until it is dropped or expires", async () => {
      const files = new DiskStore(
        await mkdtemp(join(tmpdir(), "anygriddb-files-")),
      );
      const id = await stageImport(db, files, owner, "a.csv", {
        headers: ["a"],
        rows: [["1"]],
      });
      expect((await loadStagedImport(db, files, id, owner)).rows).toEqual([
        ["1"],
      ]);
      await expect(loadStagedImport(db, files, id, viewer)).rejects.toThrow(
        "Unknown import",
      );
      await dropStagedImport(db, files, id);
      await expect(loadStagedImport(db, files, id, owner)).rejects.toThrow(
        "Unknown import",
      );
      const expired = await stageImport(db, files, owner, "b.csv", {
        headers: ["b"],
        rows: [],
      });
      await db
        .updateTable("stagedUploads")
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where("id", "=", expired)
        .execute();
      await expect(loadStagedImport(db, files, expired, owner)).rejects.toThrow(
        "Unknown import",
      );
      expect(await purgeStagedUploads(db, files, () => undefined)).toBe(1);
      const left: string[] = [];
      for await (const entry of files.list()) left.push(entry.key);
      expect(left).toEqual([]);
    });
  });

  describe("orphan files", () => {
    it("deletes old files no row names, and keeps the rest", async () => {
      const root = await mkdtemp(join(tmpdir(), "anygriddb-files-"));
      const files = new DiskStore(root);
      const baseId = (await insertBase(db, owner, { name: "Files" })).id;
      const table = await insertTable(db, owner, {
        baseId,
        name: "Docs",
        columns: [{ name: "title", label: "Title", fieldType: "text" }],
      });
      const put = (key: string) =>
        files.put(key, Buffer.from(key), "application/octet-stream");

      const attachment = `att${"k".repeat(32)}`;
      const thumbnail = `att${"t".repeat(32)}`;
      const lostAttachment = `att${"l".repeat(32)}`;
      const young = `att${"y".repeat(32)}`;
      for (const key of [attachment, thumbnail, lostAttachment, young])
        await put(key);
      await db
        .insertInto("attachments")
        .values({
          key: attachment,
          tableId: table.id,
          filename: "a.png",
          mime: "image/png",
          size: 1,
          thumbKey: thumbnail,
          createdBy: owner,
        })
        .execute();

      const job = await runningJob();
      const exported = exportKey(job.id);
      await put(exported);
      await db
        .updateTable("jobs")
        .set({ fileKey: exported })
        .where("id", "=", job.id)
        .execute();
      const lostExport = `exports/${randomUUID()}`;
      await put(lostExport);

      const stagedId = await stageImport(db, files, owner, "a.csv", {
        headers: ["a"],
        rows: [],
      });
      const staged = await db
        .selectFrom("stagedUploads")
        .select("fileKey")
        .where("id", "=", stagedId)
        .executeTakeFirstOrThrow();
      const lostStaged = `staged/${randomUUID()}`;
      await put(lostStaged);

      const old = new Date(Date.now() - 3 * 86_400_000);
      for (const key of [
        attachment,
        thumbnail,
        lostAttachment,
        exported,
        lostExport,
        staged.fileKey,
        lostStaged,
      ])
        await utimes(join(root, key), old, old);

      const orphans: string[] = [];
      const onError = vi.fn();
      const dry = await sweepOrphanFiles(
        { db, files },
        { dryRun: true, onOrphan: (key) => orphans.push(key), onError },
      );
      expect(dry).toEqual({ checked: 7, removed: 3, tidied: 0 });
      expect(orphans.sort()).toEqual(
        [lostAttachment, lostExport, lostStaged].sort(),
      );
      const listed = async () => {
        const keys: string[] = [];
        for await (const entry of files.list()) keys.push(entry.key);
        return keys.sort();
      };
      expect(await listed()).toHaveLength(8);

      expect(await sweepOrphanFiles({ db, files }, { onError })).toMatchObject({
        removed: 3,
      });
      expect(await listed()).toEqual(
        [attachment, thumbnail, young, exported, staged.fileKey].sort(),
      );
      expect(onError).not.toHaveBeenCalled();
    });
  });

  describe("trash", () => {
    it("stamps who deleted a base, and refuses one already in the trash", async () => {
      const baseId = (await insertBase(db, owner, { name: "Trashed" })).id;
      await trashBase(db, owner, baseId);
      const base = await db
        .selectFrom("bases")
        .select(["deletedAt", "deletedBy"])
        .where("id", "=", baseId)
        .executeTakeFirstOrThrow();
      expect(base.deletedBy).toBe(owner);
      expect(base.deletedAt).toBeInstanceOf(Date);
      await expect(trashBase(db, owner, baseId)).rejects.toThrow("No row");
    });

    it("keeps the last shared view of a table, and purges a trashed one", async () => {
      const baseId = (await insertBase(db, owner, { name: "Views" })).id;
      const tableId = (
        await insertTable(db, owner, {
          baseId,
          name: "Items",
          columns: [{ name: "title", label: "Title", fieldType: "text" }],
        })
      ).id;
      const [first] = await db
        .selectFrom("views")
        .selectAll()
        .where("tableId", "=", tableId)
        .execute();
      if (!first) throw new Error("no default view");
      await expect(trashView(db, owner, first)).rejects.toThrow("Invalid view");
      const { engine } = await loadEngine(db, tableId, () => true);
      const second = await createView(db, engine, {
        tableId,
        name: "Second",
        viewType: "grid",
        ownerId: null,
      });
      await trashView(db, owner, first);
      await expect(loadView(db, first.id)).rejects.toThrow("No row");
      const deps = {
        db,
        files: new DiskStore(await mkdtemp(join(tmpdir(), "anygriddb-files-"))),
        log: vi.fn(),
      };
      expect(
        await purgeItem(deps, { kind: "view", id: first.id, actorId: owner }),
      ).toBe(true);
      expect(
        await purgeItem(deps, { kind: "view", id: second.id, actorId: owner }),
      ).toBe(false);
    });
  });

  describe("a view and a field in the trash", () => {
    it("keeps the field's place and settings in a view saved meanwhile", async () => {
      const baseId = (await insertBase(db, owner, { name: "Kept" })).id;
      const tableId = (
        await insertTable(db, owner, {
          baseId,
          name: "Items",
          columns: [
            { name: "title", label: "Title", fieldType: "text" },
            { name: "remark", label: "Remark", fieldType: "text" },
            { name: "size", label: "Size", fieldType: "number" },
          ],
        })
      ).id;
      const view = await db
        .selectFrom("views")
        .selectAll()
        .where("tableId", "=", tableId)
        .executeTakeFirstOrThrow();
      const { engine } = await loadEngine(db, tableId, () => true);
      await updateView(db, engine, view, {
        patch: {
          fieldOrder: ["title", "remark", "size"],
          hiddenFields: ["remark"],
          sort: [{ column: "remark", direction: "desc" }],
        },
      });
      const table = await db
        .selectFrom("dataTables")
        .selectAll()
        .where("id", "=", tableId)
        .executeTakeFirstOrThrow();
      await trashColumn(db, owner, table, "remark");

      // Saved as the person sees it, without the field.
      const [seen] = await listViews(db, tableId, owner);
      expect(seen?.config.fieldOrder).toEqual(["title", "size"]);
      const live = await loadEngine(db, tableId, () => true);
      await updateView(db, live.engine, await loadView(db, view.id), {
        patch: {
          fieldOrder: ["size", "title"],
          hiddenFields: null,
          sort: null,
        },
      });

      const remark = await db
        .selectFrom("dataColumns")
        .select("id")
        .where("tableId", "=", tableId)
        .where("name", "=", "remark")
        .executeTakeFirstOrThrow();
      await restoreColumn(db, owner, remark.id);
      const [back] = await listViews(db, tableId, owner);
      expect(back?.config.fieldOrder).toEqual(["size", "title", "remark"]);
      expect(back?.config.hiddenFields).toEqual(["remark"]);
      expect(back?.config.sort).toEqual([
        { column: "remark", direction: "desc" },
      ]);
    });
  });

  describe("authorTable", () => {
    it("checks the author's current rights, account, and the table", async () => {
      const baseId = (await insertBase(db, owner, { name: "Authors" })).id;
      const table = await insertTable(db, owner, {
        baseId,
        name: "Clients",
        columns: [{ name: "name", label: "Name", fieldType: "text" }],
      });
      await withAudit(db, { userId: owner, source: "web" }, (tx) =>
        tx
          .insertInto("roleBindings")
          .values({
            userId: viewer,
            role: "viewer",
            scope: "base",
            scopeId: baseId,
          })
          .execute(),
      );
      const access = await authorTable(
        db,
        { userId: owner },
        table.id,
        "write",
      );
      expect(access.table.id).toBe(table.id);
      // A viewer lost nothing, but never had the right to write.
      await expect(
        authorTable(db, { userId: viewer }, table.id, "write"),
      ).rejects.toThrow("Access denied");
      expect(
        (await authorTable(db, { userId: viewer }, table.id, "read")).userId,
      ).toBe(viewer);
      await expect(
        authorTable(db, { userId: null }, table.id, "read"),
      ).rejects.toThrow("Access denied");
      await db
        .updateTable("users")
        .set({ disabledAt: new Date() })
        .where("id", "=", viewer)
        .execute();
      await expect(
        authorTable(db, { userId: viewer }, table.id, "read"),
      ).rejects.toThrow("Access denied");
      const full = await db
        .selectFrom("dataTables")
        .selectAll()
        .where("id", "=", table.id)
        .executeTakeFirstOrThrow();
      await trashTable(db, owner, full);
      await expect(
        authorTable(db, { userId: owner }, table.id, "read"),
      ).rejects.toThrow("Unknown table");
    });
  });
});
