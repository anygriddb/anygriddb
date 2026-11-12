import { randomBytes } from "node:crypto";
import type { FilterGroup } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiskStore } from "../files/index.js";
import { createTestDatabase } from "../test-database.js";
import cookie from "@fastify/cookie";
import Fastify from "fastify";
import { registerAttachmentRoutes, visibleToReader } from "../attachments.js";
import { uploadSlots } from "../upload-slots.js";
import { loadBindings } from "../auth/access.js";
import { createApiToken } from "../auth/tokens.js";
import { writeSettings } from "../settings.js";
import { clearTableAcl, readerEngine, setTableAcl } from "./acl.js";
import { withAudit } from "./audit-context.js";
import { insertComputed } from "./computed.js";
import { loadEngine } from "./engine.js";
import { addRelation, setLinks } from "./relations.js";
import {
  aggregateRows,
  assertFieldsWritable,
  assertRowsInScope,
  deleteRows,
  insertRows,
  readAudit,
  readPage,
  restoreRows,
  updateRows,
  visibleFields,
  type WriteContext,
} from "./rows.js";
import { exportBaseSnapshot, importBaseSnapshot } from "./base-snapshot.js";
import { importIntoTable } from "./import-commit.js";
import { addColumn, insertBase, insertTable } from "./schema-ops.js";

const suffix = randomBytes(6).toString("hex");
const filesRoot = await mkdtemp(join(tmpdir(), "anygriddb-files-"));

function rule(column: string, op: string, value: unknown): FilterGroup {
  return {
    conjunction: "and",
    conditions: [{ column, op, value } as FilterGroup["conditions"][number]],
  };
}

describe("field and row rules on PostgreSQL", () => {
  let database: Database;
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let owner = "";
  let editor = "";
  let baseId = "";
  let clientsId = "";
  let ordersId = "";
  let projectsId = "";
  const ids: Record<string, string> = {};

  async function context(tableId: string): Promise<WriteContext> {
    const row = await database
      .selectFrom("dataTables")
      .selectAll()
      .where("id", "=", tableId)
      .executeTakeFirst();
    return {
      userId: owner,
      tableId,
      physicalName: row?.physicalName ?? "",
      baseId,
      reason: null,
      source: "web",
    };
  }

  async function ownerEngine(tableId: string) {
    return (await loadEngine(database, tableId, () => true)).engine;
  }

  async function editorEngine(tableId: string) {
    return (
      await readerEngine(database, tableId, {
        userId: editor,
        bindings: await loadBindings(database, editor),
      })
    ).engine;
  }

  async function link(
    tableId: string,
    column: string,
    rowId: string,
    targetIds: string[],
  ) {
    const engine = await ownerEngine(tableId);
    const target = engine.table.columns.find((item) => item.name === column);
    if (!target) throw new Error(`no column ${column}`);
    const ctx = await context(tableId);
    await setLinks(database, engine, {
      userId: owner,
      tableId,
      physicalName: ctx.physicalName,
      column: target,
      rowId,
      targetIds,
      reason: null,
    });
  }

  beforeAll(async () => {
    const created = await createTestDatabase("access");
    database = created.db;
    db = created.db;
    close = created.close;

    const people = await database
      .insertInto("users")
      .values([
        { email: `owner-${suffix}@example.com`, displayName: "Owner" },
        { email: `editor-${suffix}@example.com`, displayName: "Editor" },
      ])
      .returning("id")
      .execute();
    owner = people[0]?.id ?? "";
    editor = people[1]?.id ?? "";

    baseId = (await insertBase(database, owner, { name: "Access" })).id;
    await withAudit(database, { userId: owner, source: "web" }, (tx) =>
      tx
        .insertInto("roleBindings")
        .values({
          userId: editor,
          role: "editor",
          scope: "base",
          scopeId: baseId,
        })
        .execute(),
    );
    clientsId = (
      await insertTable(database, owner, {
        baseId,
        name: "Clients",
        columns: [
          { name: "name", label: "Name", fieldType: "text" },
          { name: "city", label: "City", fieldType: "text" },
          { name: "salary", label: "Salary", fieldType: "number" },
        ],
      })
    ).id;
    ordersId = (
      await insertTable(database, owner, {
        baseId,
        name: "Orders",
        columns: [
          { name: "title", label: "Title", fieldType: "text" },
          { name: "seller", label: "Seller", fieldType: "text" },
          { name: "amount", label: "Amount", fieldType: "number" },
          {
            name: "total",
            label: "Total",
            fieldType: "formula",
            formulaSource: "{Amount} * 2",
          },
        ],
      })
    ).id;
    projectsId = (
      await insertTable(database, owner, {
        baseId,
        name: "Projects",
        columns: [{ name: "label", label: "Label", fieldType: "text" }],
      })
    ).id;
    await addRelation(database, owner, {
      tableId: ordersId,
      name: "client",
      label: "Client",
      kind: "one_to_many",
      targetTableId: clientsId,
    });
    await addRelation(database, owner, {
      tableId: ordersId,
      name: "partners",
      label: "Partners",
      kind: "many_to_many",
      targetTableId: clientsId,
      twoWay: true,
      inverseLabel: "Orders",
    });
    // A one-way link from another table into orders.
    await addRelation(database, owner, {
      tableId: projectsId,
      name: "orders",
      label: "Orders",
      kind: "many_to_many",
      targetTableId: ordersId,
    });
    const always = () => true;
    for (const [name, target, fn] of [
      ["client_city", "city", undefined],
      ["client_salary", "salary", undefined],
    ] as const) {
      await insertComputed(
        database,
        owner,
        {
          tableId: ordersId,
          name,
          label: name,
          relation: "client",
          target,
          fn,
        },
        always,
      );
    }
    await insertComputed(
      database,
      owner,
      {
        tableId: ordersId,
        name: "partner_salary",
        label: "partner_salary",
        relation: "partners",
        target: "salary",
        fn: "sum",
      },
      always,
    );

    const clientsEngine = await ownerEngine(clientsId);
    [ids.acme = "", ids.beta = ""] = await insertRows(
      database,
      clientsEngine,
      await context(clientsId),
      [
        { name: "Acme", city: "Paris", salary: 100 },
        { name: "Beta", city: "Lyon", salary: 200 },
      ],
    );
    const ordersEngine = await ownerEngine(ordersId);
    [ids.first = "", ids.second = ""] = await insertRows(
      database,
      ordersEngine,
      await context(ordersId),
      [
        { title: "first", seller: "alice", amount: 10 },
        { title: "second", seller: "bob", amount: 20 },
      ],
    );
    [ids.project = ""] = await insertRows(
      database,
      await ownerEngine(projectsId),
      await context(projectsId),
      [{ label: "Launch" }],
    );
    // A formula over a lookup: a restore must create it after the lookup.
    await addColumn(database, owner, ordersId, {
      name: "city_tag",
      label: "City tag",
      fieldType: "formula",
      formulaSource: 'ARRAY_JOIN({client_city}) & "!"',
    });
    await link(ordersId, "client", ids.first, [ids.acme]);
    await link(ordersId, "client", ids.second, [ids.beta]);
    await link(ordersId, "partners", ids.first, [ids.acme, ids.beta]);
    await link(projectsId, "orders", ids.project, [ids.first]);
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  it("reads everything without rules", async () => {
    const engine = await editorEngine(ordersId);
    expect(engine.access).toBeUndefined();
    const page = await readPage(db, engine, { limit: 10 }, { total: true });
    expect(page.total).toBe(2);
  });

  it("hides fields and rows everywhere they could show", async () => {
    await setTableAcl(database, owner, {
      tableId: ordersId,
      userId: editor,
      rowFilter: rule("seller", "is", "alice"),
      columns: [
        { column: "title", access: "write" },
        { column: "seller", access: "read" },
        { column: "total", access: "write" },
        { column: "client", access: "write" },
        { column: "partners", access: "write" },
        { column: "client_city", access: "write" },
        { column: "client_salary", access: "write" },
        { column: "partner_salary", access: "write" },
      ],
    });
    await setTableAcl(database, owner, {
      tableId: clientsId,
      userId: editor,
      rowFilter: rule("city", "is", "Paris"),
      columns: [
        { column: "name", access: "write" },
        { column: "city", access: "read" },
      ],
    });
    const engine = await editorEngine(ordersId);
    const fields = visibleFields(engine);
    expect(fields).not.toContain("amount");

    const page = await readPage(
      db,
      engine,
      { limit: 10, ...(fields ? { fields } : {}) },
      { total: true },
    );
    expect(page.total).toBe(1);
    const [row] = page.rows;
    expect(row?.id).toBe(ids.first);
    expect(row).not.toHaveProperty("amount");
    expect(row?.total).toBeNull();
    expect(row?.client_city).toEqual(["Paris"]);
    expect(row?.client_salary).toEqual([null]);
    expect(row?.partner_salary).toBeNull();
    expect(row?.partners).toEqual([{ id: ids.acme, label: "Acme" }]);

    // Filters, search, and aggregates over a hidden field reveal nothing.
    const filtered = await readPage(
      db,
      engine,
      { limit: 10, filter: rule("amount", "gt", 0) },
      { total: true },
    );
    expect(filtered.total).toBe(0);
    const searched = await readPage(
      db,
      engine,
      { limit: 10, search: "10" },
      { total: true },
    );
    expect(searched.total).toBe(0);
    const [sum] = await aggregateRows(db, engine, {}, [
      { column: "amount", fn: "sum" },
    ]);
    expect(sum).toBeNull();
    await readPage(
      db,
      engine,
      { limit: 10, sort: [{ column: "amount", direction: "desc" }] },
      { total: false },
    );

    // Writes stay inside the rules.
    await expect(
      assertRowsInScope(db, engine, [ids.second ?? ""]),
    ).rejects.toThrow("Access denied");
    await assertRowsInScope(db, engine, [ids.first ?? ""]);
    expect(() => assertFieldsWritable(engine, ["seller"])).toThrow(
      "Access denied",
    );
    expect(() => assertFieldsWritable(engine, ["amount"])).toThrow(
      "Access denied",
    );
    assertFieldsWritable(engine, ["title"]);

    // The owner still reads everything.
    const all = await readPage(
      db,
      await ownerEngine(ordersId),
      { limit: 10 },
      { total: true },
    );
    expect(all.total).toBe(2);
    // Exact numbers read as decimal text (ADR 0023).
    expect(all.rows.find((item) => item.id === ids.first)?.amount).toBe("10");
  });

  it("applies a row rule over a field the reader cannot see", async () => {
    await setTableAcl(database, owner, {
      tableId: ordersId,
      userId: editor,
      rowFilter: rule("amount", "gt", 15),
      columns: [{ column: "title", access: "write" }],
    });
    const page = await readPage(
      db,
      await editorEngine(ordersId),
      { limit: 10 },
      { total: true },
    );
    expect(page.rows.map((row) => row.id)).toEqual([ids.second]);
  });

  it("updates by key only the rows inside the importer's row rule", async () => {
    // The editor sees "second" alone (amount over 15) and writes titles.
    const table = await database
      .selectFrom("dataTables")
      .selectAll()
      .where("id", "=", ordersId)
      .executeTakeFirstOrThrow();
    const result = await importIntoTable(db, {
      userId: editor,
      table,
      staged: {
        userId: editor,
        filename: "orders.csv",
        headers: ["Title"],
        rows: [["second"], ["first"]],
      },
      mapping: [{ source: 0, column: "title" }],
      upsertSource: 0,
      addOptions: false,
      canManage: false,
      eventKey: `import:rule-${suffix}`,
      rowScope: await editorEngine(ordersId),
    });
    expect(result).toMatchObject({ inserted: 0, updated: 1, failed: 1 });
    // The row outside the rule is refused on its line, and left as it was.
    expect(result.errors).toEqual([
      {
        line: 3,
        column: "Title",
        value: "first",
        message: "Refused",
        code: "access_denied",
      },
    ]);
  });

  it("keeps no row when a stored rule no longer compiles", async () => {
    await withAudit(database, { userId: owner, source: "web" }, (tx) =>
      tx
        .updateTable("tableAcls")
        .set({ rowFilter: rule("gone", "is", "x") })
        .where("tableId", "=", ordersId)
        .execute(),
    );
    const page = await readPage(
      db,
      await editorEngine(ordersId),
      { limit: 10, timeZone: "Europe/Paris" },
      { total: true },
    );
    expect(page.total).toBe(0);
    for (const tableId of [ordersId, clientsId]) {
      await clearTableAcl(database, owner, tableId, editor);
    }
  });

  it("restores a deleted row's many-to-many links on both sides", async () => {
    const ctx = await context(ordersId);
    const engine = await ownerEngine(ordersId);
    await deleteRows(database, ctx, [ids.first ?? ""]);
    await restoreRows(database, engine, ctx, [ids.first ?? ""]);
    const restored = await readPage(
      db,
      engine,
      { limit: 10, rowIds: [ids.first ?? ""] },
      { total: false },
    );
    expect(
      (restored.rows[0]?.partners as Array<{ id: string }>).map(
        (item) => item.id,
      ),
    ).toEqual([ids.acme, ids.beta]);
    const projects = await readPage(
      db,
      await ownerEngine(projectsId),
      { limit: 10 },
      { total: false },
    );
    expect(
      (projects.rows[0]?.orders as Array<{ id: string }>).map(
        (item) => item.id,
      ),
    ).toEqual([ids.first]);

    // Deleted again without links: the earlier links must not come back.
    await link(ordersId, "partners", ids.first ?? "", []);
    await link(projectsId, "orders", ids.project ?? "", []);
    await deleteRows(database, ctx, [ids.first ?? ""]);
    await restoreRows(database, engine, ctx, [ids.first ?? ""]);
    const again = await readPage(
      db,
      engine,
      { limit: 10, rowIds: [ids.first ?? ""] },
      { total: false },
    );
    expect(again.rows[0]?.partners).toEqual([]);

    // The internal link events stay out of the row history.
    const history = await readAudit(database, ordersId, ids.first ?? "");
    expect(
      history.some((event) =>
        JSON.stringify(event.oldValue ?? {}).includes("__ag_m2m"),
      ),
    ).toBe(false);
  });

  it("round-trips a base through a snapshot", async () => {
    const { snapshot } = await exportBaseSnapshot(database, baseId, {
      withData: true,
    });
    const restored = await importBaseSnapshot(
      database,
      new DiskStore(filesRoot),
      owner,
      snapshot,
      {
        name: "Restored",
      },
    );
    const shape = async (id: string) => {
      const rows = await database
        .selectFrom("dataTables")
        .select(["name", "id"])
        .where("baseId", "=", id)
        .execute();
      const out: Record<string, string[]> = {};
      for (const table of rows) {
        const cols = await database
          .selectFrom("dataColumns")
          .select(["name", "fieldType as type"])
          .where("tableId", "=", table.id)
          .execute();
        out[table.name] = cols.map((col) => `${col.name}:${col.type}`).sort();
      }
      return out;
    };
    expect(await shape(restored.baseId)).toEqual(await shape(baseId));
    const [orders] = await database
      .selectFrom("dataTables")
      .select("id")
      .where("baseId", "=", restored.baseId)
      .execute()
      .then(async (rows) => {
        for (const row of rows) {
          const engine = await ownerEngine(row.id);
          if (engine.table.columns.some((col) => col.name === "city_tag")) {
            return [row];
          }
        }
        return [];
      });
    const page = await readPage(
      db,
      await ownerEngine(orders?.id ?? ""),
      { limit: 10, sort: [{ column: "title", direction: "asc" }] },
      { total: true },
    );
    expect(page.total).toBe(2);
    expect(page.rows.map((row) => row.city_tag)).toEqual(["Paris!", "Lyon!"]);
  });

  it("serves a file only from a field and a row the reader may see", async () => {
    await addColumn(database, owner, ordersId, {
      name: "files",
      label: "Files",
      fieldType: "attachment",
    });
    const keys = [`att${suffix}one0000000000`, `att${suffix}two0000000000`];
    await withAudit(database, { userId: owner, source: "web" }, (tx) =>
      tx
        .insertInto("attachments")
        .values(
          keys.map((key) => ({
            key,
            tableId: ordersId,
            filename: `${key}.txt`,
            mime: "text/plain",
            size: 1,
            createdBy: owner,
          })),
        )
        .execute(),
    );
    await updateRows(
      database,
      await ownerEngine(ordersId),
      await context(ordersId),
      [
        { rowId: ids.first ?? "", values: { files: [keys[0] ?? ""] } },
        { rowId: ids.second ?? "", values: { files: [keys[1] ?? ""] } },
      ],
    );
    const reader = {
      userId: editor,
      bindings: await loadBindings(database, editor),
    };
    const deps = {
      db: database,
      files: new DiskStore(filesRoot),
      uploads: uploadSlots(1),
    };
    // Without rules, reading the table is enough.
    expect(await visibleToReader(deps, reader, ordersId, keys[1] ?? "")).toBe(
      true,
    );
    await setTableAcl(database, owner, {
      tableId: ordersId,
      userId: editor,
      rowFilter: rule("seller", "is", "alice"),
      columns: [
        { column: "title", access: "write" },
        { column: "files", access: "read" },
      ],
    });
    expect(await visibleToReader(deps, reader, ordersId, keys[0] ?? "")).toBe(
      true,
    );
    expect(await visibleToReader(deps, reader, ordersId, keys[1] ?? "")).toBe(
      false,
    );
    await setTableAcl(database, owner, {
      tableId: ordersId,
      userId: editor,
      rowFilter: null,
      columns: [{ column: "title", access: "write" }],
    });
    expect(await visibleToReader(deps, reader, ordersId, keys[0] ?? "")).toBe(
      false,
    );
    await clearTableAcl(database, owner, ordersId, editor);
  });

  it("refuses an upload over the limit in force, the setting before the environment", async () => {
    const app = Fastify();
    await app.register(cookie);
    const uploads = uploadSlots(1);
    await registerAttachmentRoutes(app, {
      db: database,
      files: new DiskStore(filesRoot),
      envMaxBytes: 4096,
      uploads,
    });
    // The editor: an owner would first have to enroll a second factor.
    const { token } = await createApiToken(database, editor, "upload");
    const boundary = "----anygriddb-upload";
    const upload = async (size: number) => {
      const response = await app.inject({
        method: "POST",
        url: `/api/attachments?tableId=${ordersId}`,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": `multipart/form-data; boundary=${boundary}`,
        },
        payload: Buffer.concat([
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="note.txt"\r\nContent-Type: text/plain\r\n\r\n`,
          ),
          Buffer.alloc(size, "a"),
          Buffer.from(`\r\n--${boundary}--\r\n`),
        ]),
      });
      return response.statusCode;
    };
    try {
      expect(await upload(1024)).toBe(200);
      // Written as it arrived, then stored whole.
      const stored = await database
        .selectFrom("attachments")
        .select(["key", "size", "mime"])
        .where("tableId", "=", ordersId)
        .where("filename", "=", "note.txt")
        .orderBy("createdAt", "desc")
        .executeTakeFirstOrThrow();
      expect([Number(stored.size), stored.mime]).toEqual([1024, "text/plain"]);
      const file = await new DiskStore(filesRoot).open(stored.key);
      expect(file?.size).toBe(1024);
      file?.body.destroy();
      // Every slot taken: refused at once, and taken again once free.
      // The answer leaves before the slot is given back.
      await expect.poll(() => uploads.busy).toBe(0);
      const held = uploads.take();
      expect(held).toBeDefined();
      expect(await upload(1024)).toBe(503);
      held?.();
      expect(await upload(1024)).toBe(200);
      await expect.poll(() => uploads.busy).toBe(0);
      expect(await upload(8192)).toBe(413);
      // The setting wins over the environment, without a restart.
      await writeSettings(database, owner, { attachmentMaxBytes: 2048 });
      expect(await upload(3000)).toBe(413);
      expect(await upload(1500)).toBe(200);
    } finally {
      await writeSettings(database, owner, { attachmentMaxBytes: null });
      await app.close();
    }
  });
});
