/**
 * An account's data as a file (ROADMAP #32), against a real database: it
 * holds no cell value, no comment's text and no secret, names the fields
 * a write changed, says when a list is cut, and its job leaves an event
 * on the sign-in trail.
 */
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiToken } from "../auth/tokens.js";
import { DiskStore } from "../files/index.js";
import { jobRunners } from "../job-runners.js";
import type { JobRow } from "../jobs.js";
import { insertNativeBatch } from "../services/rows.js";
import { createTestDatabase } from "../test-database.js";
import { addComment } from "./comments.js";
import { loadEngine } from "./engine.js";
import { accountDataSummary, writeAccountDataFile } from "./account-export.js";
import { insertBase, insertTable } from "./schema-ops.js";

const suffix = randomBytes(6).toString("hex");

describe("an account's data export", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let adminId = "";
  let personId = "";
  let tableId = "";
  let baseId = "";
  let files: DiskStore;
  let folder = "";

  beforeAll(async () => {
    const created = await createTestDatabase("account_export");
    db = created.db;
    close = created.close;
    const people = await db
      .insertInto("users")
      .values([
        {
          email: `admin-${suffix}@example.org`,
          displayName: "Admin",
          isAdmin: true,
        },
        { email: `person-${suffix}@example.org`, displayName: "Leaving" },
      ])
      .returning(["id", "email"])
      .execute();
    adminId = people[0]?.id ?? "";
    personId = people[1]?.id ?? "";
    const base = await insertBase(db, personId, {
      name: `Solo ${suffix}`,
    });
    baseId = base.id;
    const table = await insertTable(db, personId, {
      baseId,
      name: "Notes",
      columns: [{ name: "title", label: "Title", fieldType: "text" }],
    });
    tableId = table.id;
    const { engine } = await loadEngine(db, table.id, () => true);
    const physical = await db
      .selectFrom("dataTables")
      .select("physicalName")
      .where("id", "=", table.id)
      .executeTakeFirstOrThrow();
    const [rowId] = await insertNativeBatch(
      db,
      engine,
      {
        userId: personId,
        tableId: table.id,
        physicalName: physical.physicalName,
        baseId,
        reason: null,
        source: "web",
      },
      [
        { title: "secret cell value" },
        { title: "another secret" },
        { title: "a third one" },
      ],
    );
    await addComment(db, {
      tableId,
      rowId: rowId ?? "",
      authorId: personId,
      body: "a comment they wrote",
    });
    await createApiToken(db, personId, "Leaving token");
    folder = await mkdtemp(join(tmpdir(), "anygriddb-account-"));
    files = new DiskStore(folder);
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  it("summarises counts and recent events without cell values", async () => {
    const summary = await accountDataSummary(db, personId);
    expect(summary.writes).toBeGreaterThan(0);
    expect(summary.comments).toBe(1);
    expect(summary.recentWrites.length).toBeGreaterThan(0);
    expect(JSON.stringify(summary)).not.toContain("secret cell value");
  });

  it("writes the file without a cell's value, a comment's text, or a secret", async () => {
    const path = join(folder, "account.json");
    const written = await writeAccountDataFile(db, personId, path);
    expect(written.counts.comments).toBe(1);
    expect(written.counts.writes).toBeGreaterThan(0);
    const text = await readFile(path, "utf8");
    expect(text).toContain(`person-${suffix}@example.org`);
    expect(text).toContain(baseId);
    // What was typed in the base stays there.
    expect(text).not.toContain("secret cell value");
    expect(text).not.toContain("another secret");
    expect(text).not.toContain("a comment they wrote");
    expect(text).not.toMatch(/old_?value|new_?value/i);
    expect(text).not.toMatch(/tokenHash|ciphertext|passwordHash/i);
    const parsed = JSON.parse(text) as {
      excludes: string[];
      memberships: { bases: Array<{ id: string; role: string }> };
      tokens: Array<Record<string, unknown>>;
      comments: Array<Record<string, unknown>>;
      writes: Array<{
        action: string;
        tableId: string | null;
        fields: string[];
      }>;
      lists: Record<string, { written: number; complete: boolean }>;
    };
    expect(parsed.excludes).toEqual(
      expect.arrayContaining(["cell values", "comment texts"]),
    );
    expect(parsed.memberships.bases).toContainEqual(
      expect.objectContaining({ id: baseId, role: "owner" }),
    );
    expect(parsed.tokens).toHaveLength(1);
    expect(parsed.tokens[0]).not.toHaveProperty("token");
    // A comment is where and when, not what.
    expect(parsed.comments).toHaveLength(1);
    expect(parsed.comments[0]).toMatchObject({ tableId, tableName: "Notes" });
    expect(parsed.comments[0]).not.toHaveProperty("body");
    // A row made names the field it filled, not every field of the row.
    const rows = parsed.writes.filter(
      (write) => write.tableId === tableId && write.action === "insert",
    );
    expect(rows).toHaveLength(3);
    for (const write of rows) expect(write.fields).toEqual(["title"]);
    expect(parsed.lists).toEqual({
      signIns: { written: written.counts.signIns, complete: true },
      comments: { written: 1, complete: true },
      writes: { written: written.counts.writes, complete: true },
    });
  });

  it("reads a list page after page, and says when it is cut", async () => {
    const whole = join(folder, "paged.json");
    const all = await writeAccountDataFile(db, personId, whole, undefined, {
      list: 10_000,
      page: 1,
    });
    const paged = JSON.parse(await readFile(whole, "utf8")) as {
      writes: Array<{ id: string }>;
    };
    // One line a page: every line once, none twice.
    expect(paged.writes).toHaveLength(all.counts.writes);
    expect(new Set(paged.writes.map((write) => write.id)).size).toBe(
      all.counts.writes,
    );

    const cut = join(folder, "cut.json");
    const some = await writeAccountDataFile(db, personId, cut, undefined, {
      list: 2,
      page: 5,
    });
    expect(some.counts.writes).toBe(2);
    const parsed = JSON.parse(await readFile(cut, "utf8")) as {
      listLimit: number;
      writes: unknown[];
      lists: Record<string, { written: number; complete: boolean }>;
    };
    expect(parsed.listLimit).toBe(2);
    expect(parsed.writes).toHaveLength(2);
    expect(parsed.lists.writes).toEqual({ written: 2, complete: false });
    // A list shorter than the limit ends where it ends.
    expect(parsed.lists.comments).toEqual({ written: 1, complete: true });
  });

  it("refuses the account every erased person becomes, and one unknown", async () => {
    await expect(
      writeAccountDataFile(
        db,
        "00000000-0000-0000-0000-000000000000",
        join(folder, "none.json"),
      ),
    ).rejects.toThrow("Invalid account");
    await expect(
      accountDataSummary(db, "11111111-1111-4111-8111-111111111111"),
    ).rejects.toThrow("Unknown account");
  });

  it("runs as a job, and leaves the export on the sign-in trail", async () => {
    const runners = jobRunners({
      db,
      bus: { publish: async () => undefined } as never,
      files,
      log: () => undefined,
    });
    const job = {
      id: "00000000-0000-4000-8000-0000000000d1",
      userId: adminId,
      input: { userId: personId },
    } as JobRow;
    const done = await runners.account_export({
      job,
      progress: async () => {},
    });
    expect(done.fileKey).toBeTruthy();
    expect(done.result).toMatchObject({ format: "json" });
    const event = await db
      .selectFrom("authEvents")
      .select(["action", "userId", "actorId"])
      .where("action", "=", "account_data_exported")
      .where("userId", "=", personId)
      .executeTakeFirst();
    expect(event).toMatchObject({
      action: "account_data_exported",
      userId: personId,
      actorId: adminId,
    });
  });
});
