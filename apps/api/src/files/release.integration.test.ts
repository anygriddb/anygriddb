/**
 * A file no cell holds is released, and storage has quotas (ADR 0136): a
 * file taken out of its cell, or whose row went to the trash, after a day's
 * grace, is released; named again (its row restored), it is held again;
 * released past the trash's days, it goes. A quota refuses the file that would go
 * past it, of a base or of its sender, and a released file counts for
 * nobody.
 */
import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppError } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { storeAttachment } from "../attachments.js";
import { withAudit } from "../data/audit-context.js";
import { insertRows } from "../data/rows.js";
import { insertBase, insertTable } from "../data/schema-ops.js";
import { loadEngine } from "../data/engine.js";
import { writeSettings } from "../settings.js";
import { createTestDatabase } from "../test-database.js";
import { DiskStore } from "./index.js";
import {
  accountStorage,
  assertStorageRoom,
  baseStorage,
  queueFileRelease,
  releaseFilesOf,
} from "./release.js";

const suffix = randomBytes(6).toString("hex");

describe("files no cell holds", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let files: DiskStore;
  let owner = "";
  let baseId = "";
  let tableId = "";
  let physical = "";
  const kept = { kept: "", dropped: "", trashed: "", shared: "" };

  /** A file stored in the table, as its sender sends it. */
  const send = async (name: string, bytes = 64) =>
    (
      await storeAttachment(db, files, {
        tableId,
        userId: owner,
        filename: name,
        bytes: Buffer.alloc(bytes, 1),
      })
    ).key;

  /** Writes, under the trail, what the table's cells hold. */
  const write = (statement: ReturnType<typeof sql>) =>
    withAudit(db, { userId: owner, tableId, source: "test" }, (tx) =>
      statement.execute(tx),
    );

  /** As if sent more than a day ago: past the grace of a file just sent. */
  const age = (key: string, days: number, column = "created_at") =>
    sql`update attachments set ${sql.ref(column)} = now() - ${`${String(days)} days`}::interval where key = ${key}`.execute(
      db,
    );

  const released = async (key: string) =>
    (
      await db
        .selectFrom("attachments")
        .select("releasedAt")
        .where("key", "=", key)
        .executeTakeFirst()
    )?.releasedAt;

  beforeAll(async () => {
    const created = await createTestDatabase("release");
    db = created.db;
    close = created.close;
    files = new DiskStore(await mkdtemp(join(tmpdir(), "anygriddb-release-")));
    owner = (
      await db
        .insertInto("users")
        .values({ email: `owner-${suffix}@example.com`, displayName: "Owner" })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;
    baseId = (await insertBase(db, owner, { name: "Dossiers" })).id;
    tableId = (
      await insertTable(db, owner, {
        baseId,
        name: "Docs",
        columns: [
          { name: "name", label: "Name", fieldType: "text" },
          { name: "files", label: "Files", fieldType: "attachment" },
        ],
      })
    ).id;
    for (const name of ["kept", "dropped", "trashed", "shared"] as const) {
      kept[name] = await send(`${name}.txt`);
    }
    const { engine, rows } = await loadEngine(db, tableId, () => true);
    physical =
      rows.tables.find((item) => item.id === tableId)?.physicalName ?? "";
    await insertRows(
      db,
      engine,
      {
        userId: owner,
        tableId,
        physicalName: physical,
        baseId,
        reason: null,
        source: "test",
      },
      [
        { name: "A", files: [kept.kept, kept.dropped, kept.shared] },
        { name: "B", files: [kept.trashed] },
        // The same file in a second row.
        { name: "C", files: [kept.shared] },
      ],
    );
    for (const key of Object.values(kept)) await age(key, 2);
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  it("releases a file its cell let go or whose row went to the trash, and keeps one a cell still names", async () => {
    await write(
      sql`update ${sql.table(physical)} set files = array[${kept.kept}, ${kept.shared}]::text[] where name = 'A'`,
    );
    // A row in the trash lives in the change trail: its files are released,
    // and kept for as long as the trash may bring the row back.
    await write(sql`delete from ${sql.table(physical)} where name = 'B'`);
    const outcome = await releaseFilesOf(db, tableId);
    expect(outcome).toEqual({ released: 2, heldAgain: 0, deleted: 0 });
    expect(await released(kept.dropped)).toBeInstanceOf(Date);
    expect(await released(kept.trashed)).toBeInstanceOf(Date);
    // Still named by row C.
    expect(await released(kept.shared)).toBeNull();
    expect(await released(kept.kept)).toBeNull();
  });

  it("holds again a file named again, and lets go a file just sent only after its grace", async () => {
    await write(
      sql`update ${sql.table(physical)} set files = array[${kept.kept}, ${kept.dropped}]::text[] where name = 'A'`,
    );
    // The trashed row restored, as the trash brings it back.
    await write(
      sql`insert into ${sql.table(physical)} (name, files) values ('B', array[${kept.trashed}]::text[])`,
    );
    const fresh = await send("fresh.txt");
    expect(await releaseFilesOf(db, tableId)).toEqual({
      released: 0,
      heldAgain: 2,
      deleted: 0,
    });
    expect(await released(kept.dropped)).toBeNull();
    expect(await released(kept.trashed)).toBeNull();
    // Sent a moment ago and in no cell yet: its change may still come.
    expect(await released(fresh)).toBeNull();
  });

  it("deletes a file released longer ago than the trash keeps, and counts it for nobody", async () => {
    await write(
      sql`update ${sql.table(physical)} set files = array[${kept.kept}]::text[] where name = 'A'`,
    );
    const before = await baseStorage(db, baseId);
    await releaseFilesOf(db, tableId);
    // `shared` is still in row C; `dropped` is released, and counts no more.
    expect(await baseStorage(db, baseId)).toBe(before - 64);
    expect(await accountStorage(db, owner)).toBe(before - 64);
    await age(kept.dropped, 31, "released_at");
    expect((await releaseFilesOf(db, tableId)).deleted).toBe(1);
    expect(await released(kept.dropped)).toBeUndefined();
  });

  it("refuses the file that would take a base, or its sender, past a quota", async () => {
    const held = await baseStorage(db, baseId);
    const refusal = async (size: number) => {
      try {
        await assertStorageRoom(db, { tableId, userId: owner, size });
        return "ok";
      } catch (error) {
        return error instanceof AppError ? error.code : "thrown";
      }
    };
    // No quota: nothing is refused.
    expect(await refusal(1024 ** 3)).toBe("ok");
    // A quota is set in MiB: one MiB here, what the base holds included.
    const mib = 1024 * 1024;
    await writeSettings(db, owner, { limits: { "storage.base_mib": 1 } });
    expect(await refusal(mib - held)).toBe("ok");
    expect(await refusal(mib - held + 1)).toBe("base_storage_full");
    await writeSettings(db, owner, {
      limits: { "storage.base_mib": 0, "storage.account_mib": 1 },
    });
    expect(await refusal(mib - held + 1)).toBe("account_storage_full");
    // As it is refused when the file is sent.
    await expect(send("too-big.txt", mib)).rejects.toMatchObject({
      code: "account_storage_full",
    });
    await writeSettings(db, owner, { limits: {} });
    expect(await refusal(64)).toBe("ok");
  });

  it("refuses what would go past a quota, though files are sent together", async () => {
    const mib = 1024 * 1024;
    // Each file fits alone; two of them do not.
    const size = Math.ceil((mib - (await accountStorage(db, owner))) * 0.6);
    const stored = async () => {
      const keys: string[] = [];
      for await (const entry of files.list()) keys.push(entry.key);
      return keys.length;
    };
    const held = async () =>
      Math.max(await accountStorage(db, owner), await baseStorage(db, baseId));
    for (const limits of [
      { "storage.account_mib": 1 },
      { "storage.base_mib": 1 },
    ]) {
      await writeSettings(db, owner, { limits });
      const before = await stored();
      const outcomes = await Promise.allSettled(
        ["one", "two", "three"].map((name) => send(`${name}.bin`, size)),
      );
      try {
        // A file refused once sent leaves nothing in the store.
        expect(await stored()).toBe(before + 1);
        expect(
          outcomes.map((outcome) =>
            outcome.status === "fulfilled"
              ? "stored"
              : outcome.reason instanceof AppError
                ? outcome.reason.code
                : "thrown",
          ),
        ).toEqual(
          expect.arrayContaining(["stored", expect.stringMatching(/_full$/)]),
        );
        expect(
          outcomes.filter((outcome) => outcome.status === "fulfilled"),
        ).toHaveLength(1);
        expect(await held()).toBeLessThanOrEqual(mib);
      } finally {
        await writeSettings(db, owner, { limits: {} });
        // What this round stored counts for nobody in the next.
        await db
          .updateTable("attachments")
          .set({ releasedAt: new Date() })
          .where("filename", "like", "%.bin")
          .execute();
      }
    }
  });

  it("queues one look a little after changes of a table that holds files, and none for one that holds none", async () => {
    const queued = async (key: string) =>
      Number(
        (
          await sql<{
            count: string;
          }>`select count(*)::text as count from graphile_worker.jobs where key = ${key}`.execute(
            db,
          )
        ).rows[0]?.count ?? 0,
      );
    await queueFileRelease(db, tableId);
    await queueFileRelease(db, tableId);
    expect(await queued(`file_release:${tableId}`)).toBe(1);
    const plain = (
      await insertTable(db, owner, {
        baseId,
        name: "Plain",
        columns: [{ name: "name", label: "Name", fieldType: "text" }],
      })
    ).id;
    await queueFileRelease(db, plain);
    expect(await queued(`file_release:${plain}`)).toBe(0);
  });

  it("looks at a table with no files, or of a client's database, as nothing", async () => {
    expect(
      await releaseFilesOf(db, "00000000-0000-4000-8000-000000000001"),
    ).toEqual({
      released: 0,
      heldAgain: 0,
      deleted: 0,
    });
  });
});
