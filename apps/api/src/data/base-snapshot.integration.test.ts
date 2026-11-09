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
import { withAudit } from "./audit-context.js";
import {
  exportBaseSnapshot,
  importBaseSnapshot,
  packSnapshot,
} from "./base-snapshot.js";
import { loadEngine } from "./engine.js";
import { insertRows, readPage } from "./rows.js";
import { insertBase, insertTable } from "./schema-ops.js";
import {
  openStagedSnapshot,
  snapshotFolder,
  stageSnapshotFile,
} from "./snapshot-stage.js";
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
    const folder = await snapshotFolder();
    const result = await exportBaseSnapshot(db, baseId, { withData: true });
    const packed = await packSnapshot(files, result, folder.path);
    return { folder, packed, result };
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
      const row = result.snapshot.tables[0]?.rows?.[0];
      expect(row?.who).toEqual([`ada-${suffix}@example.com`]);
      expect(row?.files).toEqual([
        { file: expect.any(String), name: "plan.png" },
        { file: expect.any(String), name: "notes.txt" },
      ]);
      expect(isZip(await readFile(packed.path))).toBe(true);
      const archive = await ZipReader.open(packed.path, { maxEntries: 10 });
      // The document and the two files, the shared one once.
      expect(archive.entries.size).toBe(3);
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
      });
      const role = await db
        .selectFrom("roleBindings")
        .select("role")
        .where("userId", "=", ada)
        .where("scopeId", "=", imported.baseId)
        .executeTakeFirst();
      expect(role?.role).toBe("editor");

      const { tableId, rows } = await rowsOf(imported.baseId);
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
      const path = join(folder.path, "lying.json");
      // A JSON snapshot naming files has none to give: cells come back empty.
      await writeFile(path, JSON.stringify(result.snapshot));
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
        },
      );
      await opened.close();
      expect(imported.report.filesMissing).toBe(2);

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
    const { snapshot } = await exportBaseSnapshot(db, baseId, {
      withData: false,
    });
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
    });
    expect(await viewsOf(kept.baseId)).toEqual(["Grid"]);

    const bare = {
      ...snapshot,
      tables: snapshot.tables.map((table) => ({ ...table, views: [] })),
    };
    const named = await importBaseSnapshot(db, files, owner, bare, {
      names: madeNames("fr"),
    });
    expect(await viewsOf(named.baseId)).toEqual(["Grille"]);
  });
});
