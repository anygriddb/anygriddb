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
import { MAX_SNAPSHOT_TABLES } from "@anygriddb/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { storeAttachment } from "../attachments.js";
import { DiskStore, readFile as readStored } from "../files/index.js";
import { writeSettings } from "../settings.js";
import { createTestDatabase } from "../test-database.js";
import { listTableAcls } from "./acl.js";
import { narrowOn } from "./rules.test-helpers.js";
import { withAudit } from "./audit-context.js";
import { importBaseSnapshot } from "./base-snapshot.js";
import {
  createDashboard,
  getDashboard,
  listDashboards,
  upsertWidget,
  widgetData,
} from "./dashboards.js";
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
import { createView } from "./views.js";
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
        .insertInto("attributions")
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
    await narrowOn(db, owner, {
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

  it("takes a base at the table limit, and refuses one past it", async () => {
    const wide = (await insertBase(db, owner, { name: "Large" })).id;
    for (let index = 0; index < MAX_SNAPSHOT_TABLES; index += 1) {
      await insertTable(db, owner, {
        baseId: wide,
        name: `T${index}`,
        columns: [{ name: "title", label: "Title", fieldType: "text" }],
      });
    }
    const { snapshot } = await snapshotOf(db, files, wide, { withData: true });
    expect(snapshot.tables).toHaveLength(MAX_SNAPSHOT_TABLES);
    await insertTable(db, owner, {
      baseId: wide,
      name: "One too many",
      columns: [{ name: "title", label: "Title", fieldType: "text" }],
    });
    for (const withData of [true, false]) {
      await expect(
        snapshotOf(db, files, wide, { withData }),
      ).rejects.toMatchObject({ code: "snapshot_too_many_tables" });
    }
  }, 120_000);

  it("writes an archive with the files, people by email, and members", async () => {
    const { folder, packed, result } = await exported();
    try {
      expect(packed.kind).toBe("zip");
      if (packed.kind !== "zip") return;
      expect(packed.filename).toBe("Dossiers.anygriddb.zip");
      // Ada's rule took her role table by table (ADR 0131): she is no
      // member of the base, and her role travels with the table.
      expect(result.snapshot.members).toEqual(
        expect.arrayContaining([
          { email: `owner-${suffix}@example.com`, role: "owner" },
          { email: `bob-${suffix}@example.com`, role: "viewer" },
        ]),
      );
      const table = result.snapshot.tables[0];
      expect(table?.rows).toBeUndefined();
      expect(table?.rowCount).toBe(2);
      expect(table?.access).toEqual([
        {
          email: `ada-${suffix}@example.com`,
          role: "editor",
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
        filesRefused: 0,
        people: 2,
        peopleDropped: 1,
        members: 0,
        membersMissing: 1,
        membersLeft: 0,
        membersRoleMissing: 0,
        widgetsLeft: 0,
      });
      const { tableId, rows } = await rowsOf(imported.baseId);
      const role = await db
        .selectFrom("attributions")
        .select("role")
        .where("userId", "=", ada)
        .where("scope", "=", "table")
        .where("scopeId", "=", tableId)
        .executeTakeFirst();
      expect(role?.role).toBe("editor");

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

  it("leaves out a file of an extension refused since, and says so", async () => {
    const { folder, packed } = await exported();
    try {
      if (packed.kind !== "zip") throw new Error("not an archive");
      await writeSettings(db, owner, { attachmentRefusedExtensions: [".txt"] });
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
          readFile: opened.readFile,
          readLines: opened.readLines,
          maxRows: 1_000_000,
        },
      );
      await opened.close();
      // The picture comes back; the note is of a refused extension.
      expect(imported.report).toMatchObject({
        files: 1,
        filesMissing: 0,
        filesRefused: 1,
      });
    } finally {
      await writeSettings(db, owner, { attachmentRefusedExtensions: [] });
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

  it("keeps the base's dashboards, their widgets reading the new base's tables and views", async () => {
    const source = (await insertBase(db, owner, { name: "Pilotage" })).id;
    const tableId = (
      await insertTable(db, owner, {
        baseId: source,
        name: "Orders",
        columns: [
          { name: "name", label: "Name", fieldType: "text" },
          { name: "amount", label: "Amount", fieldType: "number" },
        ],
      })
    ).id;
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
        baseId: source,
        reason: null,
        source: "test",
      },
      [
        { name: "A", amount: "50" },
        { name: "B", amount: "150" },
        { name: "C", amount: "250" },
      ],
    );
    // The grid made with the table, a view everyone has, and one only
    // its author has: a snapshot holds the first two.
    const large = await createView(db, engine, owner, {
      tableId,
      name: "Large",
      viewType: "grid",
      config: {
        filter: {
          conjunction: "and",
          conditions: [{ column: "amount", op: "gt", value: "100" }],
        },
      },
      ownerId: null,
    });
    const mine = await createView(db, engine, owner, {
      tableId,
      name: "Mine",
      viewType: "grid",
      ownerId: owner,
    });

    const overview = await createDashboard(db, owner, {
      baseId: source,
      name: "Overview",
      description: "The week",
    });
    await createDashboard(db, owner, { baseId: source, name: "Empty" });
    const widget = (
      title: string,
      kind: "metric" | "chart" | "view_embed",
      y: number,
      config: Record<string, unknown>,
    ) =>
      upsertWidget(db, owner, source, {
        dashboardId: overview.id,
        title,
        kind,
        x: 0,
        y,
        w: 6,
        h: 3,
        config: { tableId, ...config },
      });
    await widget("Large total", "metric", 0, {
      viewId: large.id,
      column: "amount",
      fn: "sum",
    });
    await widget("By name", "chart", 3, {
      groupBy: "name",
      chartType: "bar",
      fn: "count_all",
    });
    await widget("Large rows", "view_embed", 6, { viewId: large.id });
    await widget("My total", "metric", 9, {
      viewId: mine.id,
      column: "amount",
      fn: "sum",
    });

    /** A base's dashboards as a reader finds them, ids apart. */
    const boardsOf = async (ofBase: string) => {
      const table = await db
        .selectFrom("dataTables")
        .select("id")
        .where("baseId", "=", ofBase)
        .executeTakeFirstOrThrow();
      const views = await db
        .selectFrom("views")
        .select(["id", "name"])
        .where("tableId", "=", table.id)
        .execute();
      const viewName = new Map(views.map((view) => [view.id, view.name]));
      const boards = [];
      for (const listed of await listDashboards(db, ofBase)) {
        const { widgets } = await getDashboard(db, listed.id);
        boards.push({
          name: listed.name,
          description: listed.description,
          widgets: widgets.map((item) => {
            const { tableId: read, viewId, ...settings } = item.config;
            return {
              title: item.title,
              kind: item.kind,
              place: [item.x, item.y, item.w, item.h],
              ownTable: read === table.id,
              view: typeof viewId === "string" ? viewName.get(viewId) : null,
              settings,
            };
          }),
          rows: widgets,
        });
      }
      return boards;
    };
    const kept = [
      {
        name: "Overview",
        description: "The week",
        widgets: [
          {
            title: "Large total",
            kind: "metric",
            place: [0, 0, 6, 3],
            ownTable: true,
            view: "Large",
            settings: { column: "amount", fn: "sum" },
          },
          {
            title: "By name",
            kind: "chart",
            place: [0, 3, 6, 3],
            ownTable: true,
            view: null,
            settings: { groupBy: "name", chartType: "bar", fn: "count_all" },
          },
          {
            title: "Large rows",
            kind: "view_embed",
            place: [0, 6, 6, 3],
            ownTable: true,
            view: "Large",
            settings: {},
          },
        ],
      },
      { name: "Empty", description: null, widgets: [] },
    ];
    const plain = (boards: Awaited<ReturnType<typeof boardsOf>>) =>
      boards.map(({ rows: _rows, ...board }) => board);

    // The schema alone: the dashboards, each widget by its table's key
    // and its view's rank, and the one the file could not hold counted.
    const schema = await snapshotOf(db, files, source, { withData: false });
    await schema.close();
    expect(schema.snapshot.dashboards).toEqual([
      {
        name: "Overview",
        description: "The week",
        left: 1,
        widgets: [
          {
            title: "Large total",
            kind: "metric",
            x: 0,
            y: 0,
            w: 6,
            h: 3,
            table: "orders",
            view: 1,
            config: { column: "amount", fn: "sum" },
          },
          {
            title: "By name",
            kind: "chart",
            x: 0,
            y: 3,
            w: 6,
            h: 3,
            table: "orders",
            config: { groupBy: "name", chartType: "bar", fn: "count_all" },
          },
          {
            title: "Large rows",
            kind: "view_embed",
            x: 0,
            y: 6,
            w: 6,
            h: 3,
            table: "orders",
            view: 1,
            config: {},
          },
        ],
      },
      { name: "Empty", widgets: [] },
    ]);
    if (schema.packed.kind !== "json") throw new Error("not a JSON snapshot");
    // No id of the base it leaves is written with them.
    const written = schema.packed.bytes.toString("utf8");
    expect(written).not.toContain(tableId);
    expect(written).not.toContain(large.id);

    const copy = await importBaseSnapshot(db, files, owner, schema.snapshot, {
      maxRows: 1_000_000,
    });
    expect(plain(await boardsOf(copy.baseId))).toEqual(kept);
    expect(copy.report.widgetsLeft).toBe(1);

    // With its rows: the figure of the new base is read from its own
    // table, through its own view.
    const archived = await snapshotOf(db, files, source, { withData: true });
    try {
      expect(archived.snapshot.dashboards).toEqual(schema.snapshot.dashboards);
      const restored = await importBaseSnapshot(
        db,
        files,
        owner,
        archived.snapshot,
        { maxRows: 1_000_000, readLines: archived.readLines },
      );
      const boards = await boardsOf(restored.baseId);
      expect(plain(boards)).toEqual(kept);
      const figure = boards[0]?.rows.find((row) => row.title === "Large total");
      if (!figure) throw new Error("no figure");
      const read = await widgetData(
        { db },
        {
          widget: figure,
          userId: owner,
          bindings: [
            { role: "owner", scope: "base", scopeId: restored.baseId },
          ],
          canReadTable: () => true,
          timeZone: "UTC",
        },
      );
      expect(read).toMatchObject({ kind: "metric", value: "400" });
    } finally {
      await archived.close();
    }

    // A base without dashboards gives the snapshot it always gave, and
    // brings none.
    const bare = await snapshotOf(db, files, baseId, { withData: false });
    await bare.close();
    if (bare.packed.kind !== "json") throw new Error("not a JSON snapshot");
    expect(bare.packed.bytes.toString("utf8")).not.toMatch(/"dashboards":/);
    const none = await importBaseSnapshot(db, files, owner, bare.snapshot, {
      maxRows: 1_000_000,
    });
    expect(await listDashboards(db, none.baseId)).toEqual([]);
    expect(none.report.widgetsLeft).toBe(0);
  });
});
