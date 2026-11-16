/**
 * A whole base shared read-only by one link (ROADMAP row 93), through the
 * real public procedures on a migrated database: each table its creator
 * reads, as they read it, no file's key, the password and its lock, and a
 * link that stops when it should.
 */
import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { storeAttachment } from "../attachments.js";
import { keyRing } from "../auth/key-ring.js";
import { setTableAcl } from "../data/acl.js";
import { withAudit } from "../data/audit-context.js";
import { loadEngine } from "../data/engine.js";
import { insertRows } from "../data/rows.js";
import { insertBase, insertTable } from "../data/schema-ops.js";
import { createBaseShare, revokeShare } from "../data/sharing.js";
import { trashBase } from "../data/trash.js";
import type { Env } from "../env.js";
import { DiskStore } from "../files/index.js";
import { writeSettings } from "../settings.js";
import { createTestDatabase } from "../test-database.js";
import { browserFactory, errorCode } from "./caller.test-helpers.js";

const suffix = randomBytes(6).toString("hex");

describe("a base shared by one link", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  const env = {
    AUTH_ENCRYPTION_KEY: keyRing(randomBytes(32)),
    PUBLIC_URL: "https://grid.example.org",
  } as unknown as Env;
  const hub = {
    closeUser: vi.fn(() => 0),
    closeAllBut: vi.fn(() => 0),
    closeSession: vi.fn(() => 0),
  };
  const visitor = browserFactory({ db: () => db, env, hub })();
  let owner = "";
  let ada = "";
  let baseId = "";
  let clients = "";
  let notes = "";

  beforeAll(async () => {
    const created = await createTestDatabase("base_share");
    db = created.db;
    close = created.close;
    [owner, ada] = (
      await db
        .insertInto("users")
        .values([
          { email: `owner-${suffix}@example.org`, displayName: "Owner" },
          { email: `ada-${suffix}@example.org`, displayName: "Ada" },
        ])
        .returning("id")
        .execute()
    ).map((row) => row.id) as [string, string];
    baseId = (await insertBase(db, owner, { name: "Ventes" })).id;
    await withAudit(db, { userId: owner }, (tx) =>
      tx
        .insertInto("roleBindings")
        .values({ userId: ada, role: "viewer", scope: "base", scopeId: baseId })
        .execute(),
    );
    clients = (
      await insertTable(db, owner, {
        baseId,
        name: "Clients",
        columns: [
          { name: "name", label: "Name", fieldType: "text" },
          { name: "margin", label: "Margin", fieldType: "text" },
          { name: "files", label: "Files", fieldType: "attachment" },
        ],
      })
    ).id;
    notes = (
      await insertTable(db, owner, {
        baseId,
        name: "Notes",
        columns: [{ name: "text", label: "Text", fieldType: "text" }],
      })
    ).id;
    const files = new DiskStore(
      await mkdtemp(join(tmpdir(), "anygriddb-files-")),
    );
    const file = await storeAttachment(db, files, {
      tableId: clients,
      userId: owner,
      filename: "contract.txt",
      bytes: Buffer.from("signed"),
    });
    const { engine, rows } = await loadEngine(db, clients, () => true);
    const physical = rows.tables.find((table) => table.id === clients);
    if (!physical) throw new Error("no table");
    await insertRows(
      db,
      engine,
      {
        userId: owner,
        tableId: clients,
        physicalName: physical.physicalName,
        baseId,
        reason: null,
        source: "test",
      },
      [{ name: "Acme", margin: "12", files: [file.key] }],
    );
    // Ada reads the clients, but not their margin.
    await setTableAcl(db, owner, {
      tableId: clients,
      userId: ada,
      rowFilter: null,
      columns: [
        { column: "name", access: "read" },
        { column: "files", access: "read" },
      ],
    });
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  const open = (token: string, extra: { access?: string } = {}) =>
    visitor.call().share.openBase({ token, ...extra });
  const unlock = (token: string, password: string) =>
    visitor.call().share.unlockBase({ token, password });
  const rowsOf = (token: string, tableId: string, access?: string) =>
    visitor
      .call()
      .share.baseRows({ token, tableId, ...(access ? { access } : {}) });

  it("shows each table its creator reads, with its rows, and no file's key", async () => {
    const link = await createBaseShare(db, { baseId, createdBy: owner });
    const opened = await open(link.token);
    expect(opened.locked).toBe(false);
    expect(opened.base?.name).toBe("Ventes");
    expect(opened.tables.map((table) => table.name)).toEqual([
      "Clients",
      "Notes",
    ]);
    expect(
      opened.tables[0]?.columns.map((column) => column.name).sort(),
    ).toEqual(["files", "margin", "name"]);
    const read = await rowsOf(link.token, clients);
    expect(read.total).toBe(1);
    expect(read.rows[0]).toMatchObject({
      name: "Acme",
      margin: "12",
      files: [],
    });
    expect((await rowsOf(link.token, notes)).total).toBe(0);
  });

  it("reads as the member who made it: a field hidden from them stays hidden", async () => {
    const link = await createBaseShare(db, { baseId, createdBy: ada });
    const opened = await open(link.token);
    expect(
      opened.tables
        .find((table) => table.name === "Clients")
        ?.columns.map((column) => column.name)
        .sort(),
    ).toEqual(["files", "name"]);
    const [row] = (await rowsOf(link.token, clients)).rows;
    expect(row).toMatchObject({ name: "Acme" });
    expect(row).not.toHaveProperty("margin");
  });

  it("asks its password, and locks guesses but not who gave it", async () => {
    const link = await createBaseShare(db, {
      baseId,
      createdBy: owner,
      password: "a base password",
    });
    expect((await open(link.token)).locked).toBe(true);
    expect(await errorCode(rowsOf(link.token, clients))).toBe("unknown_share");
    const granted = await unlock(link.token, "a base password");
    expect(granted.locked).toBe(false);
    const access = granted.access ?? undefined;
    // The proof opens the link; the password is never part of a reading.
    expect((await open(link.token, { access })).locked).toBe(false);
    for (let attempt = 0; attempt < 9; attempt += 1) {
      expect((await unlock(link.token, "wrong")).locked).toBe(true);
    }
    expect(await errorCode(unlock(link.token, "wrong"))).toBe("share_locked");
    expect((await rowsOf(link.token, clients, access)).total).toBe(1);
  });

  it("stops when revoked, expired, off, its creator gone, or its base trashed", async () => {
    const revoked = await createBaseShare(db, { baseId, createdBy: owner });
    await revokeShare(db, owner, revoked.id);
    expect(await errorCode(open(revoked.token))).toBe("unknown_share");

    const expired = await createBaseShare(db, { baseId, createdBy: owner });
    // A link's expiry is on the change trail: the write names its author.
    await withAudit(db, { userId: owner }, (tx) =>
      tx
        .updateTable("shares")
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where("id", "=", expired.id)
        .execute(),
    );
    expect(await errorCode(open(expired.token))).toBe("unknown_share");

    // A table of another base is not this link's to read.
    const link = await createBaseShare(db, { baseId, createdBy: owner });
    const other = (await insertBase(db, owner, { name: "Elsewhere" })).id;
    const outside = (
      await insertTable(db, owner, {
        baseId: other,
        name: "Secrets",
        columns: [{ name: "name", label: "Name", fieldType: "text" }],
      })
    ).id;
    expect(await errorCode(rowsOf(link.token, outside))).toBe("unknown_share");

    await writeSettings(db, owner, { publicLinks: "off" });
    expect(await errorCode(open(link.token))).toBe("unknown_share");
    await writeSettings(db, owner, { publicLinks: "allowed" });
    expect((await open(link.token)).locked).toBe(false);

    const byAda = await createBaseShare(db, { baseId, createdBy: ada });
    await withAudit(db, { userId: owner }, (tx) =>
      tx
        .deleteFrom("roleBindings")
        .where("userId", "=", ada)
        .where("scopeId", "=", baseId)
        .execute(),
    );
    expect(await errorCode(open(byAda.token))).toBe("unknown_share");

    await trashBase(db, owner, baseId);
    expect(await errorCode(open(link.token))).toBe("unknown_share");
  });
});
