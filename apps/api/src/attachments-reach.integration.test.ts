/**
 * Which file a key opens, on a migrated database: the file of a cell the
 * reader may see, and no other. A cell that holds another table's key says
 * nothing of that file, and a file that left its cell is no longer served.
 */
import { randomBytes } from "node:crypto";
import { indexName } from "@anygriddb/core";
import { type Database, runStatement } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { enrichAttachments, visibleToReader } from "./attachments.js";
import { loadBindings } from "./auth/access.js";
import { keyRing } from "./auth/key-ring.js";
import { createApiToken } from "./auth/tokens.js";
import { withAudit } from "./data/audit-context.js";
import { buildFileIndexes, fileFieldsIndexed } from "./data/file-indexes.js";
import { readerEngine } from "./data/acl.js";
import { insertBase, insertTable } from "./data/schema-ops.js";
import type { Env } from "./env.js";
import { DiskStore } from "./files/index.js";
import { writeSettings } from "./settings.js";
import { createTestDatabase } from "./test-database.js";
import { browserFactory, errorCode } from "./trpc/caller.test-helpers.js";
import { uploadSlots } from "./upload-slots.js";

const suffix = randomBytes(6).toString("hex");

describe("which file a key opens", () => {
  let db: Database;
  let ownerDb: Database;
  let url = "";
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
  const browser = browserFactory({ db: () => db, env, hub });
  const page = browser();
  let owner = "";
  let viewer = "";
  let ownerToken = "";
  let baseId = "";
  let tableId = "";
  let otherTable = "";
  let foreignTable = "";

  const as = (token: string) => page.call({ authorization: `Bearer ${token}` });
  const key = (name: string) =>
    `att${suffix}${name}`.padEnd(30, "0").slice(0, 30);
  const addFile = (name: string, table: string) =>
    withAudit(db, { userId: owner, source: "web" }, (tx) =>
      tx
        .insertInto("attachments")
        .values({
          key: key(name),
          tableId: table,
          filename: `${name}.txt`,
          mime: "text/plain",
          size: 7,
          createdBy: owner,
        })
        .execute(),
    );
  const canRead = async (name: string) =>
    visibleToReader(
      {
        db,
        files: new DiskStore("/tmp"),
        uploads: uploadSlots(1),
      } as never,
      { userId: viewer, bindings: await loadBindings(db, viewer) },
      tableId,
      key(name),
    );
  const physical = async (id: string) =>
    (
      await db
        .selectFrom("dataTables")
        .select("physicalName")
        .where("id", "=", id)
        .executeTakeFirstOrThrow()
    ).physicalName;

  beforeAll(async () => {
    const created = await createTestDatabase("attachments_reach");
    db = created.db;
    ownerDb = created.owner.db;
    close = created.close;
    url = created.owner.url;
    [owner, viewer] = (
      await db
        .insertInto("users")
        .values([
          { email: `owner-${suffix}@example.org`, displayName: "Owner" },
          { email: `viewer-${suffix}@example.org`, displayName: "Viewer" },
        ])
        .returning("id")
        .execute()
    ).map((row) => row.id) as [string, string];
    await writeSettings(db, owner, { mfaScope: "admins" });
    baseId = (await insertBase(db, owner, { name: "Files" })).id;
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
    const columns = [
      { name: "title", label: "Title", fieldType: "text" as const },
      { name: "doc", label: "Doc", fieldType: "attachment" as const },
      {
        name: "tags",
        label: "Tags",
        fieldType: "multi_select" as const,
        config: { options: [{ name: "a", color: "red" as const }] },
      },
    ];
    tableId = (await insertTable(db, owner, { baseId, name: "T", columns })).id;
    otherTable = (await insertTable(db, owner, { baseId, name: "U", columns }))
      .id;
    const elsewhere = (await insertBase(db, owner, { name: "Other" })).id;
    foreignTable = (
      await insertTable(db, owner, { baseId: elsewhere, name: "V", columns })
    ).id;
    ownerToken = (await createApiToken(db, owner, "owner", { days: 1 })).token;
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  it("names a file of the table, and nothing of another's", async () => {
    await addFile("mine", tableId);
    await addFile("neighbour", otherTable);
    await addFile("foreign", foreignTable);
    const rows: Array<Record<string, unknown>> = [
      { doc: [key("mine"), key("neighbour"), key("foreign")] },
    ];
    await enrichAttachments(db, tableId, ["doc"], rows);
    const files = rows[0]?.doc as Array<{
      key: string;
      filename: string;
      size: number;
    }>;
    expect(files[0]?.filename).toBe("mine.txt");
    expect(files[0]?.size).toBe(7);
    for (const file of files.slice(1)) {
      expect(file.filename).toBe(file.key);
      expect(file.size).toBe(0);
    }
  });

  it("refuses a change of a list into a file field", async () => {
    expect(
      await errorCode(
        as(ownerToken).catalog.updateColumn({
          tableId,
          name: "tags",
          fieldType: "attachment",
        }),
      ),
    ).toBe("invalid_conversion");
  });

  it("gives a file field its index, on a new table and a new field", async () => {
    const { engine } = await readerEngine(db, tableId, {
      userId: owner,
      bindings: await loadBindings(db, owner),
    });
    expect(await fileFieldsIndexed(db, engine)).toBe(true);
    await as(ownerToken).catalog.addColumn({
      tableId: otherTable,
      name: "more",
      label: "More",
      fieldType: "attachment",
    });
    const added = await readerEngine(db, otherTable, {
      userId: owner,
      bindings: await loadBindings(db, owner),
    });
    expect(await fileFieldsIndexed(db, added.engine)).toBe(true);
  });

  it("builds a missing index, and one left unfinished, beside the writes", async () => {
    const table = await physical(foreignTable);
    const name = indexName(table, "doc", "gin");
    await runStatement(ownerDb, { text: `drop index "${name}"`, values: [] });
    const { engine } = await readerEngine(db, foreignTable, {
      userId: owner,
      bindings: await loadBindings(db, owner),
    });
    expect(await fileFieldsIndexed(db, engine)).toBe(false);
    await buildFileIndexes(db, url, { error: vi.fn(), info: vi.fn() });
    expect(await fileFieldsIndexed(db, engine)).toBe(true);

    // An index a failed build left behind does not count, and is rebuilt.
    await runStatement(ownerDb, {
      text: `update pg_index set indisvalid = false where indexrelid = '"${name}"'::regclass`,
      values: [],
    });
    expect(await fileFieldsIndexed(db, engine)).toBe(false);
    await buildFileIndexes(db, url, { error: vi.fn(), info: vi.fn() });
    expect(await fileFieldsIndexed(db, engine)).toBe(true);
  });

  it("serves a file while a cell holds it, and not once it left", async () => {
    await addFile("kept", tableId);
    await addFile("dropped", tableId);
    const owners = as(ownerToken);
    const row = await owners.rows.insert({
      tableId,
      values: {
        title: "a",
        doc: [key("kept"), key("dropped")],
      },
    });
    expect(await canRead("kept")).toBe(true);
    expect(await canRead("dropped")).toBe(true);
    await owners.rows.updateMany({
      tableId,
      updates: [{ rowId: row.id, values: { doc: [key("kept")] } }],
    });
    expect(await canRead("kept")).toBe(true);
    expect(await canRead("dropped")).toBe(false);
    await owners.rows.updateMany({
      tableId,
      updates: [
        { rowId: row.id, values: { doc: [key("kept"), key("dropped")] } },
      ],
    });
    expect(await canRead("dropped")).toBe(true);
  });

  it("stops serving it with its row in the trash, until the row is back", async () => {
    await addFile("trashed", tableId);
    const owners = as(ownerToken);
    const row = await owners.rows.insert({
      tableId,
      values: { title: "b", doc: [key("trashed")] },
    });
    expect(await canRead("trashed")).toBe(true);
    await owners.rows.deleteMany({ tableId, rowIds: [row.id] });
    expect(await canRead("trashed")).toBe(false);
    await owners.rows.restore({ tableId, rowIds: [row.id] });
    expect(await canRead("trashed")).toBe(true);
  });

  it("stops serving it with its field in the trash", async () => {
    await addFile("column", tableId);
    const owners = as(ownerToken);
    await owners.catalog.addColumn({
      tableId,
      name: "scans",
      label: "Scans",
      fieldType: "attachment",
    });
    await owners.rows.insert({
      tableId,
      values: { title: "c", scans: [key("column")] },
    });
    expect(await canRead("column")).toBe(true);
    await owners.catalog.deleteColumn({ tableId, name: "scans" });
    expect(await canRead("column")).toBe(false);
  });

  it("does not read a table cell by cell before its index is built", async () => {
    await addFile("waiting", tableId);
    const owners = as(ownerToken);
    await owners.rows.insert({
      tableId,
      values: { title: "d", doc: [key("waiting")] },
    });
    const table = await physical(tableId);
    const name = indexName(table, "doc", "gin");
    await runStatement(ownerDb, { text: `drop index "${name}"`, values: [] });
    // Until it is there, a reader without rules keeps the answer they had.
    expect(await canRead("no-such-cell")).toBe(true);
    await buildFileIndexes(db, url, { error: vi.fn(), info: vi.fn() });
    expect(await canRead("no-such-cell")).toBe(false);
    expect(await canRead("waiting")).toBe(true);
  });
});
