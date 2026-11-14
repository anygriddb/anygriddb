/**
 * Base snapshots with their files and people (ADR 0039), against a real
 * database: an archive written, uploaded, checked, and imported.
 */
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { madeNames } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { storeAttachment } from "../attachments.js";
import { DiskStore, readFile as readStored } from "../files/index.js";
import { createTestDatabase } from "../test-database.js";
import { listTableAcls, setTableAcl } from "./acl.js";
import { withAudit } from "./audit-context.js";
import { importBaseSnapshot } from "./base-snapshot.js";
import { snapshotOf } from "./snapshot.test-helpers.js";
import { loadEngine } from "./engine.js";
import {
  createFolder,
  deleteFolder,
  listFolders,
  moveTableToFolder,
} from "./folders.js";
import { insertRows, readPage } from "./rows.js";
import { insertBase, insertTable } from "./schema-ops.js";
import { openStagedSnapshot, stageSnapshotFile } from "./snapshot-stage.js";
import { isZip, ZipReader } from "./zip.js";

const suffix = randomBytes(6).toString("hex");

describe("snapshots with files and people", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let files: DiskStore;
  let owner = "";
  let ada = "";
  let bob = "";
  let baseId = "";
  let image = Buffer.alloc(0);
  let note = Buffer.alloc(0);

  beforeAll(async () => {
    const created = await createTestDatabase("snapshots");
    db = created.db;
    close = created.close;
    files = new DiskStore(await mkdtemp(join(tmpdir(), "anygriddb-files-")));
    const people = await db
      .insertInto("users")
      .values([
        { email: `owner-${suffix}@example.com`, displayName: "Owner" },
        { email: `ada-${suffix}@example.com`, displayName: "Ada" },
        { email: `bob-${suffix}@example.com`, displayName: "Bob" },
      ])
      .returning("id")
      .execute();
    [owner, ada, bob] = people.map((person) => person.id) as [
      string,
      string,
      string,
    ];
    baseId = (await insertBase(db, owner, { name: "Dossiers" })).id;
    await withAudit(db, { userId: owner }, (tx) =>
      tx
        .insertInto("roleBindings")
        .values([
          { userId: ada, role: "editor", scope: "base", scopeId: baseId },
          { userId: bob, role: "viewer", scope: "base", scopeId: baseId },
        ])
        .execute(),
    );
    const tableId = (
      await insertTable(db, owner, {
        baseId,
        name: "Docs",
        columns: [
          { name: "name", label: "Name", fieldType: "text" },
          { name: "files", label: "Files", fieldType: "attachment" },
          {
            name: "who",
            label: "Who",
            fieldType: "user",
            config: { multiple: true },
          },
        ],
      })
    ).id;
    // Ada edits, but not the files, and only the rows with a name.
    await setTableAcl(db, owner, {
      tableId,
      userId: ada,
      rowFilter: {
        conjunction: "and",
        conditions: [{ column: "name", op: "is_not_empty" }],
      },
      columns: [{ column: "files", access: "hide" }],
    });
    image = await sharp({
      create: { width: 40, height: 30, channels: 3, background: "#c00" },
    })
      .png()
      .toBuffer();
    note = Buffer.from("Compte rendu\n", "utf8");
    const picture = await storeAttachment(db, files, {
      tableId,
      userId: owner,
      filename: "plan.png",
      bytes: image,
    });
    const text = await storeAttachment(db, files, {
      tableId,
      userId: owner,
      filename: "notes.txt",
      bytes: note,
    });
    const { engine, rows } = await loadEngine(db, tableId, () => true);
    const physical = rows.tables.find((item) => item.id === tableId);
    if (!physical) throw new Error("no table");
    await insertRows(
      db,
      engine,
      {
        userId: owner,
        tableId,
        physicalName: physical.physicalName,
        baseId,
        reason: null,
        source: "test",
      },
      [
        { name: "A", files: [picture.key, text.key], who: [ada] },
        // The same file in a second row: stored once on import.
        { name: "B", files: [picture.key], who: [ada, bob] },
      ],
    );
  });

  afterAll(async () => {
    await close?.();
  });

  async function exported() {
    const result = await snapshotOf(db, files, baseId, { withData: true });
    return { folder: result.folder, packed: result.packed, result };
  }

  async function rowsOf(newBaseId: string) {
    const table = await db
      .selectFrom("dataTables")
      .select("id")
      .where("baseId", "=", newBaseId)
      .executeTakeFirstOrThrow();
    const { engine } = await loadEngine(db, table.id, () => true);
    const page = await readPage(db, engine, { limit: 10 }, { total: false });
    return { tableId: table.id, rows: page.rows };
  }

  it("writes an archive with the files, people by email, and members", async () => {
    const { folder, packed, result } = await exported();
    try {
      expect(packed.kind).toBe("zip");
      if (packed.kind !== "zip") return;
      expect(packed.filename).toBe("Dossiers.anygriddb.zip");
      expect(result.snapshot.members).toEqual(
        expect.arrayContaining([
          { email: `owner-${suffix}@example.com`, role: "owner" },
          { email: `ada-${suffix}@example.com`, role: "editor" },
        ]),
      );
      const table = result.snapshot.tables[0];
      expect(table?.rows).toBeUndefined();
      expect(table?.rowCount).toBe(2);
      expect(table?.access).toEqual([
        {
          email: `ada-${suffix}@example.com`,
          rowFilter: {
            conjunction: "and",
            conditions: [{ column: "name", op: "is_not_empty" }],
          },
          columns: [{ column: "files", access: "hide" }],
        },
      ]);
      const [row] = await result.linesOf(table?.key ?? "");
      expect(row?.who).toEqual([`ada-${suffix}@example.com`]);
      expect(row?.files).toEqual([
        { file: expect.any(String), name: "plan.png" },
        { file: expect.any(String), name: "notes.txt" },
      ]);
      expect(isZip(await readFile(packed.path))).toBe(true);
      const archive = await ZipReader.open(packed.path, { maxEntries: 10 });
      // The document, the table's rows, and the two files, the shared one
      // once.
      expect(archive.entries.size).toBe(4);
    } finally {
      await folder.remove();
    }
  });

  it("brings files, people, and members back through an upload", async () => {
    const { folder, packed } = await exported();
    try {
      if (packed.kind !== "zip") throw new Error("not an archive");
      // Bob's account is disabled here: his role does not come back.
      await db
        .updateTable("users")
        .set({ disabledAt: new Date() })
        .where("id", "=", bob)
        .execute();
      const staged = await stageSnapshotFile(db, files, {
        userId: owner,
        path: packed.path,
        size: packed.size,
        filename: packed.filename,
      });
      const opened = await openStagedSnapshot(
        db,
        files,
        staged.snapshotId,
        owner,
      );
      const imported = await importBaseSnapshot(
        db,
        files,
        owner,
        opened.snapshot,
        {
          name: "Restaurée",
          restoreMembers: true,
          readFile: opened.readFile,
          readLines: opened.readLines,
          maxRows: 1_000_000,
        },
      );
      await opened.close();
      expect(imported.report).toEqual({
        files: 2,
        filesMissing: 0,
        people: 2,
        peopleDropped: 1,
        members: 1,
        membersMissing: 1,
        membersLeft: 0,
      });
      const role = await db
        .selectFrom("roleBindings")
        .select("role")
        .where("userId", "=", ada)
        .where("scopeId", "=", imported.baseId)
        .executeTakeFirst();
      expect(role?.role).toBe("editor");

      const { tableId, rows } = await rowsOf(imported.baseId);
      // Her rules come with her role: the new base hides what the old did.
      expect(await listTableAcls(db, tableId)).toEqual([
        {
          userId: ada,
          rowFilter: {
            conjunction: "and",
            conditions: [{ column: "name", op: "is_not_empty" }],
          },
          columns: [{ column: "files", access: "hide" }],
        },
      ]);
      const a = rows.find((row) => row.name === "A");
      const b = rows.find((row) => row.name === "B");
      expect(a?.who).toEqual([ada]);
      expect(b?.who).toEqual([ada]);
      const keys = (a?.files ?? []) as string[];
      expect(keys).toHaveLength(2);
      expect((b?.files as string[])[0]).toBe(keys[0]);
      const stored = await db
        .selectFrom("attachments")
        .selectAll()
        .where("tableId", "=", tableId)
        .orderBy("filename")
        .execute();
      expect(stored.map((item) => [item.filename, item.mime])).toEqual([
        ["notes.txt", "text/plain"],
        ["plan.png", "image/png"],
      ]);
      // The picture's bytes, and a thumbnail made again.
      const picture = stored.find((item) => item.filename === "plan.png");
      expect(picture?.thumbKey).not.toBeNull();
      expect(picture?.width).toBe(40);
      const bytes = await readStored(files, picture?.key ?? "", 1e6);
      expect(bytes?.bytes.equals(image)).toBe(true);
    } finally {
      await db
        .updateTable("users")
        .set({ disabledAt: null })
        .where("id", "=", bob)
        .execute();
      await folder.remove();
    }
  });

  it("leaves out people who are not members, and a file that does not match", async () => {
    const { folder, packed } = await exported();
    try {
      if (packed.kind !== "zip") throw new Error("not an archive");
      const staged = await stageSnapshotFile(db, files, {
        userId: owner,
        path: packed.path,
        size: packed.size,
        filename: packed.filename,
      });
      const opened = await openStagedSnapshot(
        db,
        files,
        staged.snapshotId,
        owner,
      );
      // A file whose SHA-256 differs from the listed one is not trusted.
      const [first] = opened.snapshot.files ?? [];
      if (!first) throw new Error("no file");
      first.sha256 = "0".repeat(64);
      const imported = await importBaseSnapshot(
        db,
        files,
        owner,
        opened.snapshot,
        {
          readFile: opened.readFile,
          readLines: opened.readLines,
          maxRows: 1_000_000,
        },
      );
      await opened.close();
      expect(imported.report).toMatchObject({
        files: 1,
        filesMissing: 1,
        people: 0,
        peopleDropped: 3,
        members: 0,
      });
    } finally {
      await folder.remove();
    }
  });

  it("refuses an archive whose listed file is missing, and still reads JSON", async () => {
    const { folder, packed, result } = await exported();
    try {
      if (packed.kind !== "zip") throw new Error("not an archive");
      const table = result.snapshot.tables[0];
      if (!table) throw new Error("no table");
      // Rows written the version 2 way, inside the JSON.
      const { rowCount: _count, ...schema } = table;
      const legacy = {
        ...result.snapshot,
        version: 2,
        files: undefined,
        tables: [
          {
            ...schema,
            rows: (await result.linesOf(table.key)).map(
              ({ __seq: seq, __position: _place, ...cells }) => ({
                __id: seq,
                ...cells,
              }),
            ),
          },
        ],
      };
      const lines = join(folder.path, "lines.json");
      // Version 3 rows live in an archive's entries: a JSON file cannot
      // carry them.
      await writeFile(lines, JSON.stringify(result.snapshot));
      await expect(
        stageSnapshotFile(db, files, {
          userId: owner,
          path: lines,
          size: (await readFile(lines)).length,
          filename: "lines.json",
        }),
      ).rejects.toThrow("Invalid snapshot");
      const path = join(folder.path, "lying.json");
      // A JSON snapshot naming files has none to give: cells come back empty.
      await writeFile(path, JSON.stringify(legacy));
      const staged = await stageSnapshotFile(db, files, {
        userId: owner,
        path,
        size: (await readFile(path)).length,
        filename: "lying.json",
      });
      const opened = await openStagedSnapshot(
        db,
        files,
        staged.snapshotId,
        owner,
      );
      const imported = await importBaseSnapshot(
        db,
        files,
        owner,
        opened.snapshot,
        {
          readFile: opened.readFile,
          maxRows: 1_000_000,
        },
      );
      await opened.close();
      expect(imported.report.filesMissing).toBe(2);
      const { rows } = await rowsOf(imported.baseId);
      expect(rows.map((row) => row.name).sort()).toEqual(["A", "B"]);

      const truncated = join(folder.path, "truncated.zip");
      const bytes = await readFile(packed.path);
      await writeFile(truncated, bytes.subarray(0, bytes.length - 30));
      await expect(
        stageSnapshotFile(db, files, {
          userId: owner,
          path: truncated,
          size: bytes.length - 30,
          filename: "truncated.zip",
        }),
      ).rejects.toThrow("Invalid snapshot");
    } finally {
      await folder.remove();
    }
  });

  it("keeps the snapshot's views alone, and names a grid where it lists none", async () => {
    const schema = await snapshotOf(db, files, baseId, { withData: false });
    await schema.close();
    expect(schema.packed.kind).toBe("json");
    const { snapshot } = schema;
    const viewsOf = async (newBaseId: string) =>
      (
        await db
          .selectFrom("views")
          .innerJoin("dataTables", "dataTables.id", "views.tableId")
          .select("views.name")
          .where("dataTables.baseId", "=", newBaseId)
          .orderBy("views.position")
          .execute()
      ).map((view) => view.name);
    const listed = snapshot.tables[0]?.views.map((view) => view.name);
    expect(listed).toEqual(["Grid"]);

    // A French reader's import: the snapshot's grid only, no "Grille".
    const kept = await importBaseSnapshot(db, files, owner, snapshot, {
      names: madeNames("fr"),
      maxRows: 1_000_000,
    });
    expect(await viewsOf(kept.baseId)).toEqual(["Grid"]);

    const bare = {
      ...snapshot,
      tables: snapshot.tables.map((table) => ({ ...table, views: [] })),
    };
    const named = await importBaseSnapshot(db, files, owner, bare, {
      names: madeNames("fr"),
      maxRows: 1_000_000,
    });
    expect(await viewsOf(named.baseId)).toEqual(["Grille"]);
  });
  it("keeps the folders its tables are in, and their order", async () => {
    const arranged = (await insertBase(db, owner, { name: "Rangement" })).id;
    const table = async (name: string) =>
      (
        await insertTable(db, owner, {
          baseId: arranged,
          name,
          columns: [{ name: "name", label: "Name", fieldType: "text" }],
        })
      ).id;
    const loose = await table("Loose");
    const invoices = await table("Invoices");
    const quotes = await table("Quotes");
    const old = await table("Old");
    const folder = async (name: string) =>
      (await createFolder(db, owner, { baseId: arranged, name })).id;
    const sales = await folder("Sales");
    await folder("Empty");
    const archive = await folder("Archive");
    const gone = await folder("Gone");
    // In Sales, Quotes comes before Invoices, against the order they
    // were made in.
    await moveTableToFolder(db, owner, { tableId: quotes, folderId: sales });
    await moveTableToFolder(db, owner, { tableId: invoices, folderId: sales });
    await moveTableToFolder(db, owner, { tableId: old, folderId: archive });
    await deleteFolder(db, owner, gone);
    expect(loose).not.toBe("");

    /** Each folder's tables in their order, the root's under "". */
    const arrangement = async (ofBase: string) => {
      const placed = await db
        .selectFrom("dataTables")
        .leftJoin("tableFolders", "tableFolders.id", "dataTables.folderId")
        .select(["dataTables.name as name", "tableFolders.name as folder"])
        .where("dataTables.baseId", "=", ofBase)
        .orderBy("dataTables.position")
        .orderBy("dataTables.createdAt")
        .execute();
      const byFolder: Record<string, string[]> = {};
      for (const row of placed) {
        (byFolder[row.folder ?? ""] ??= []).push(row.name);
      }
      return {
        folders: (await listFolders(db, [ofBase])).map((item) => item.name),
        tables: byFolder,
      };
    };
    const before = await arrangement(arranged);
    expect(before).toEqual({
      folders: ["Sales", "Empty", "Archive"],
      tables: {
        "": ["Loose"],
        Sales: ["Quotes", "Invoices"],
        Archive: ["Old"],
      },
    });

    // The schema alone, then the archive with its rows: both name them.
    const schema = await snapshotOf(db, files, arranged, { withData: false });
    await schema.close();
    expect(schema.snapshot.folders).toEqual([
      { name: "Sales" },
      { name: "Empty" },
      { name: "Archive" },
    ]);
    expect(
      Object.fromEntries(
        schema.snapshot.tables.map((item) => [item.name, item.folder]),
      ),
    ).toEqual({
      Loose: undefined,
      Invoices: "Sales",
      Quotes: "Sales",
      Old: "Archive",
    });
    const copy = await importBaseSnapshot(db, files, owner, schema.snapshot, {
      maxRows: 1_000_000,
    });
    expect(await arrangement(copy.baseId)).toEqual(before);

    const archived = await snapshotOf(db, files, arranged, { withData: true });
    try {
      expect(archived.snapshot.folders).toEqual(schema.snapshot.folders);
      const restored = await importBaseSnapshot(
        db,
        files,
        owner,
        archived.snapshot,
        { maxRows: 1_000_000, readLines: archived.readLines },
      );
      expect(await arrangement(restored.baseId)).toEqual(before);
    } finally {
      await archived.close();
    }

    // A base without folders gives the snapshot it always gave, and one
    // written before folders were kept still makes its base.
    const plain = await snapshotOf(db, files, baseId, { withData: false });
    await plain.close();
    if (plain.packed.kind !== "json") throw new Error("not a JSON snapshot");
    expect(plain.packed.bytes.toString("utf8")).not.toMatch(/"folders?":/);
    const { folders: _folders, ...earlier } = schema.snapshot;
    const flat = await importBaseSnapshot(
      db,
      files,
      owner,
      {
        ...earlier,
        tables: earlier.tables.map(({ folder: _folder, ...item }) => item),
      },
      { maxRows: 1_000_000 },
    );
    expect(await arrangement(flat.baseId)).toEqual({
      folders: [],
      tables: { "": ["Loose", "Quotes", "Old", "Invoices"] },
    });
  });
});
