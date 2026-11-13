import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { indexName } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadBindings } from "../auth/access.js";
import { withAudit } from "../data/audit-context.js";
import { readPage } from "../data/rows.js";
import { insertBase, insertTable } from "../data/schema-ops.js";
import { gridChannel } from "../realtime/channels.js";
import { recordingBus } from "../realtime/recording-bus.test-helpers.js";
import { createTestDatabase } from "../test-database.js";
import {
  changeStatus,
  createRows,
  deleteRows,
  findLiveTable,
  loadRowScope,
  moveRows,
  restoreRows,
  type RowScope,
} from "./rows.js";

const suffix = randomBytes(6).toString("hex");

describe("rows in the order people give them", () => {
  let database: Database;
  let close: (() => Promise<void>) | undefined;
  const recorder = recordingBus();
  let ownerId = "";
  let tableId = "";

  beforeAll(async () => {
    const created = await createTestDatabase("roworder");
    database = created.db;
    close = created.close;
    const [owner] = await database
      .insertInto("users")
      .values({ email: `owner-${suffix}@example.com`, displayName: "Owner" })
      .returning("id")
      .execute();
    ownerId = owner?.id ?? "";
    const baseId = (await insertBase(database, ownerId, { name: "Order" })).id;
    tableId = (
      await insertTable(database, ownerId, {
        baseId,
        name: "Steps",
        columns: [{ name: "title", label: "Title", fieldType: "text" }],
      })
    ).id;
  });

  afterAll(async () => {
    await close?.();
  });

  const deps = () => ({
    db: database,
    bus: recorder.bus,
    log: () => undefined,
  });

  async function scope(): Promise<RowScope> {
    const table = await findLiveTable(database, tableId);
    if (!table) throw new Error("no table");
    return loadRowScope(
      database,
      { userId: ownerId, bindings: await loadBindings(database, ownerId) },
      table,
    );
  }

  async function titles(): Promise<string[]> {
    const { engine } = await scope();
    const page = await readPage(
      database,
      engine,
      { limit: 100, fields: ["title"] },
      { total: false },
    );
    return page.rows.map((row) => String(row.title));
  }

  async function add(
    title: string,
    place?: { before: string } | { after: string },
  ) {
    const [id] = await createRows(
      deps(),
      await scope(),
      [{ values: { title } }],
      { source: "web" },
      place,
    );
    if (!id) throw new Error("no row");
    return id;
  }

  async function places(): Promise<string[]> {
    const table = await findLiveTable(database, tableId);
    const found = await sql<{ position: string }>`
      select "ag_position"::text as position
      from ${sql.table(table?.physicalName ?? "")}
      order by "ag_position", "ag_seq"
    `.execute(database);
    return found.rows.map((row) => row.position);
  }

  it("puts a new row just above or just below another, and the others at the end", async () => {
    const a = await add("A");
    const c = await add("C");
    await add("B", { before: c });
    await add("A2", { after: a });
    await add("Top", { before: a });
    await add("D", { after: c });
    await add("E");
    expect(await titles()).toEqual(["Top", "A", "A2", "B", "C", "D", "E"]);
    // Several rows placed at once keep the order they were given.
    const ids = await createRows(
      deps(),
      await scope(),
      [{ values: { title: "C1" } }, { values: { title: "C2" } }],
      { source: "web" },
      { after: c },
    );
    expect(ids).toHaveLength(2);
    expect(await titles()).toEqual([
      "Top",
      "A",
      "A2",
      "B",
      "C",
      "C1",
      "C2",
      "D",
      "E",
    ]);
  });

  it("keeps places short when rows go into the same gap again and again", async () => {
    const first = await add("Gap start");
    let last = await add("Gap end");
    for (let index = 0; index < 40; index += 1) {
      last = await add(`In ${String(index)}`, { before: last });
    }
    const all = await titles();
    expect(all.indexOf("Gap start")).toBeLessThan(all.indexOf("In 39"));
    expect(all.indexOf("In 0")).toBeLessThan(all.indexOf("Gap end"));
    // Forty halvings of one gap: about twelve decimals, not forty.
    const longest = Math.max(
      ...(await places()).map((place) => place.split(".")[1]?.length ?? 0),
    );
    expect(longest).toBeLessThanOrEqual(14);
    expect(first).toBeTruthy();
  });

  it("moves rows beside another, keeping their order, and tells open tabs", async () => {
    const one = await add("One");
    const two = await add("Two");
    const three = await add("Three");
    const four = await add("Four");
    recorder.published.length = 0;
    // Asked in any order, the rows keep the order they had.
    const moved = await moveRows(
      deps(),
      await scope(),
      [four, three],
      { before: two },
      { source: "web" },
    );
    expect(new Set(moved)).toEqual(new Set([three, four]));
    const after = await titles();
    expect(after.slice(after.indexOf("One"), after.indexOf("One") + 4)).toEqual(
      ["One", "Three", "Four", "Two"],
    );
    expect(recorder.published).toContainEqual({
      channel: gridChannel(tableId),
      message: {
        type: "rows",
        channel: tableId,
        op: "refresh",
        rowIds: moved,
      },
    });
    // To the top of the table, and after its last row.
    const topRow = (await titles())[0];
    expect(topRow).toBe("Top");
    await moveRows(
      deps(),
      await scope(),
      [one],
      { after: four },
      {
        source: "web",
      },
    );
    const end = await add("End");
    await moveRows(
      deps(),
      await scope(),
      [end],
      { before: three },
      {
        source: "web",
      },
    );
    const final = await titles();
    expect(final.slice(final.indexOf("End"), final.indexOf("End") + 5)).toEqual(
      ["End", "Three", "Four", "One", "Two"],
    );
  });

  it("records a move on the trail without changing the row's last change", async () => {
    const row = await add("Moved");
    const anchor = await add("Anchor");
    const table = await findLiveTable(database, tableId);
    const stamp = () =>
      sql<{ at: string }>`
        select "ag_updated_at"::text as at
        from ${sql.table(table?.physicalName ?? "")}
        where "id" = ${row}::uuid
      `.execute(database);
    const before = (await stamp()).rows[0]?.at;
    await moveRows(
      deps(),
      await scope(),
      [row],
      { after: anchor },
      {
        source: "web",
      },
    );
    expect((await stamp()).rows[0]?.at).toBe(before);
    const events = await database
      .selectFrom("auditEvents")
      .select(["action", "oldValue", "newValue", "source"])
      .where("tableId", "=", tableId)
      .where("recordId", "=", row)
      .orderBy("occurredAt", "asc")
      .execute();
    expect(events.map((event) => event.action)).toEqual(["insert", "update"]);
    const move = events[1];
    const old = move?.oldValue as Record<string, unknown>;
    const now = move?.newValue as Record<string, unknown>;
    expect(old.ag_position).not.toEqual(now.ag_position);
    expect({ ...old, ag_position: null }).toEqual({
      ...now,
      ag_position: null,
    });
    expect(move?.source).toBe("web");
  });

  it("brings a deleted row back to its place", async () => {
    const left = await add("Left");
    const middle = await add("Middle", { after: left });
    await add("Right", { after: middle });
    await deleteRows(deps(), await scope(), [middle], { source: "web" });
    await restoreRows(deps(), await scope(), [middle], { source: "restore" });
    const all = await titles();
    expect(all.slice(all.indexOf("Left"), all.indexOf("Left") + 3)).toEqual([
      "Left",
      "Middle",
      "Right",
    ]);
  });

  it("refuses to move a locked row, a row beside itself, or beside no row", async () => {
    const kept = await add("Kept");
    const other = await add("Other");
    const owner = { ...(await scope()), role: "owner" as const };
    await changeStatus(deps(), owner, kept, "submitted", { source: "web" });
    await changeStatus(deps(), owner, kept, "locked", { source: "web" });
    await expect(
      moveRows(
        deps(),
        await scope(),
        [kept],
        { after: other },
        {
          source: "web",
        },
      ),
    ).rejects.toMatchObject({ code: "row_locked" });
    // A row can still be put beside a locked one.
    const beside = await add("Beside", { before: kept });
    const all = await titles();
    expect(all.indexOf("Beside")).toBe(all.indexOf("Kept") - 1);
    await moveRows(
      deps(),
      await scope(),
      [other],
      { after: kept },
      {
        source: "web",
      },
    );
    await expect(
      moveRows(
        deps(),
        await scope(),
        [beside, other],
        { after: other },
        {
          source: "web",
        },
      ),
    ).rejects.toMatchObject({ code: "invalid_place" });
    await expect(
      add("Nowhere", { after: "00000000-0000-4000-8000-000000000000" }),
    ).rejects.toMatchObject({ code: "no_row" });
  });
});

describe("the migration that gives rows a place", () => {
  let database: Database;
  let close: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const created = await createTestDatabase("roworder_migration");
    database = created.db;
    close = created.close;
  });

  afterAll(async () => {
    await close?.();
  });

  it("keeps the order rows had, and numbers new rows after every number given", async () => {
    const [owner] = await database
      .insertInto("users")
      .values({ email: `old-${suffix}@example.com`, displayName: "Old" })
      .returning("id")
      .execute();
    const baseId = (
      await insertBase(database, owner?.id ?? "", { name: "Old" })
    ).id;
    const physical = `t_old_${suffix}`;
    // A table as AnyGridDB made them before rows had a place.
    await sql`
      create table ${sql.table(physical)} (
        "id" uuid primary key default ag_uuidv7(),
        "ag_seq" bigint generated by default as identity,
        "title" text
      )
    `.execute(database);
    await sql`
      insert into ${sql.table(physical)} ("title")
      values ('first'), ('second'), ('third'), ('gone')
    `.execute(database);
    await sql`delete from ${sql.table(physical)} where "title" = 'gone'`.execute(
      database,
    );
    await withAudit(
      database,
      { userId: owner?.id ?? "", source: "web" },
      (tx) =>
        tx
          .insertInto("dataTables")
          .values({ baseId, name: "Old", physicalName: physical })
          .execute(),
    );
    const migration = await readFile(
      new URL(
        "../../../../packages/db/migrations/0069_row_positions.sql",
        import.meta.url,
      ),
      "utf8",
    );
    // Only the step that walks the tables: the rest is in place already,
    // and every other table of this database has its place.
    await sql
      .raw(migration.slice(migration.indexOf("DO $$")))
      .execute(database);
    const rows = await sql<{ title: string; position: string; seq: string }>`
      select "title", "ag_position"::text as position, "ag_seq"::text as seq
      from ${sql.table(physical)}
      order by "ag_position", "ag_seq"
    `.execute(database);
    expect(rows.rows.map((row) => row.title)).toEqual([
      "first",
      "second",
      "third",
    ]);
    expect(rows.rows.every((row) => row.position === row.seq)).toBe(true);
    await sql`insert into ${sql.table(physical)} ("title") values ('new')`.execute(
      database,
    );
    const added = await sql<{ position: string }>`
      select "ag_position"::text as position
      from ${sql.table(physical)}
      where "title" = 'new'
    `.execute(database);
    // Past the deleted row's number too: it may come back from the trash.
    expect(Number(added.rows[0]?.position)).toBeGreaterThan(4);
    const index = await sql<{ name: string }>`
      select indexname as name from pg_indexes where tablename = ${physical}
    `.execute(database);
    expect(index.rows.map((row) => row.name)).toContain(
      indexName(physical, "ag_position", "ix"),
    );
  });
});
