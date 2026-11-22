/**
 * A purge and a restore of the same item, on two connections: the purge is
 * held just before it drops anything, by a read of the table.
 */
import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppError } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DiskStore } from "../files/index.js";
import { createTestDatabase } from "../test-database.js";
import { withAudit } from "./audit-context.js";
import { insertBase, insertTable } from "./schema-ops.js";
import {
  dueTrashItems,
  listTrash,
  listTrashedBases,
  purgeItem,
  restoreBase,
  restoreColumn,
  restoreTable,
  trashBase,
  trashColumn,
  trashTable,
} from "./trash.js";
import { loadCatalogRows } from "./engine.js";

const suffix = randomBytes(6).toString("hex");

describe("a purge and a restore of one item", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let files: DiskStore;
  let owner = "";
  let baseId = "";
  const deps = () => ({ db, files, log: () => undefined });

  beforeAll(async () => {
    const created = await createTestDatabase("purge_race");
    db = created.db;
    close = created.close;
    files = new DiskStore(await mkdtemp(join(tmpdir(), "ag-purge-race-")));
    const [person] = await db
      .insertInto("users")
      .values([{ email: `owner-${suffix}@example.com`, displayName: "Owner" }])
      .returning("id")
      .execute();
    owner = person?.id ?? "";
    baseId = (await insertBase(db, owner, { name: "Race" })).id;
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  async function table(inBase = baseId) {
    const { id } = await insertTable(db, owner, {
      baseId: inBase,
      name: `T ${randomBytes(4).toString("hex")}`,
      columns: [
        { name: "label", label: "Label", fieldType: "text" },
        { name: "extra", label: "Extra", fieldType: "text" },
      ],
    });
    return db
      .selectFrom("dataTables")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
  }

  async function columnId(tableId: string, name: string) {
    const column = await db
      .selectFrom("dataColumns")
      .select("id")
      .where("tableId", "=", tableId)
      .where("name", "=", name)
      .executeTakeFirstOrThrow();
    return column.id;
  }

  const stillThere = async (physical: string) => {
    const { rows } = await sql<{ found: string | null }>`
      select to_regclass(${`public."${physical}"`})::text as found
    `.execute(db);
    return rows[0]?.found !== null;
  };

  /** Holds a read of `physical` until `release()`: a DROP waits behind it. */
  async function hold(physical: string) {
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started: () => void = () => undefined;
    const holding = new Promise<void>((resolve) => {
      started = resolve;
    });
    const done = db.transaction().execute(async (tx) => {
      await sql`lock table ${sql.table(physical)} in access share mode`.execute(
        tx,
      );
      started();
      await released;
    });
    await holding;
    return {
      release: async () => {
        release();
        await done;
      },
    };
  }

  /** Waits until a statement naming `physical` waits for a lock. */
  async function blocked(physical: string, statement: string) {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const { rows } = await sql<{ waiting: string }>`
        select count(*)::text as waiting from pg_stat_activity
        where wait_event_type = 'Lock'
          and query ilike ${`%${statement}%${physical}%`}
      `.execute(db);
      if (rows[0]?.waiting !== "0") return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("the purge never reached its drop");
  }

  async function code(call: Promise<unknown>): Promise<string> {
    try {
      await call;
    } catch (error) {
      if (error instanceof AppError) return error.code;
      throw error;
    }
    return "done";
  }

  describe("a restore that lands first", () => {
    it("keeps the table, and the purge passes over it", async () => {
      const item = await table();
      await trashTable(db, owner, item);
      await restoreTable(db, owner, item.id);
      expect(
        await purgeItem(deps(), { kind: "table", id: item.id, actorId: owner }),
      ).toBe(false);
      expect(await stillThere(item.physicalName)).toBe(true);
    });

    it("keeps the field", async () => {
      const item = await table();
      await trashColumn(db, owner, item, "extra");
      const id = await columnId(item.id, "extra");
      await restoreColumn(db, owner, id);
      expect(
        await purgeItem(deps(), { kind: "column", id, actorId: owner }),
      ).toBe(false);
      const kept = await db
        .selectFrom("dataColumns")
        .select("deletedAt")
        .where("id", "=", id)
        .executeTakeFirstOrThrow();
      expect(kept.deletedAt).toBeNull();
    });

    it("keeps the base and its tables", async () => {
      const own = (await insertBase(db, owner, { name: "Kept" })).id;
      const item = await table(own);
      await trashBase(db, owner, own);
      await restoreBase(db, owner, own);
      expect(
        await purgeItem(deps(), { kind: "base", id: own, actorId: owner }),
      ).toBe(false);
      expect(await stillThere(item.physicalName)).toBe(true);
    });
  });

  describe("a restore that lands while the purge runs", () => {
    it("is refused for a table, which is then gone", async () => {
      const item = await table();
      await trashTable(db, owner, item);
      const held = await hold(item.physicalName);
      const purge = purgeItem(deps(), {
        kind: "table",
        id: item.id,
        actorId: owner,
      });
      await blocked(item.physicalName, "drop table");
      expect(await code(restoreTable(db, owner, item.id))).toBe("no_row");
      await held.release();
      expect(await purge).toBe(true);
      expect(await stillThere(item.physicalName)).toBe(false);
    });

    it("is refused for a field, which is then gone", async () => {
      const item = await table();
      await trashColumn(db, owner, item, "extra");
      const id = await columnId(item.id, "extra");
      const held = await hold(item.physicalName);
      const purge = purgeItem(deps(), { kind: "column", id, actorId: owner });
      await blocked(item.physicalName, "alter table");
      expect(await code(restoreColumn(db, owner, id))).toBe("no_row");
      await held.release();
      expect(await purge).toBe(true);
      const gone = await db
        .selectFrom("dataColumns")
        .select("id")
        .where("id", "=", id)
        .executeTakeFirst();
      expect(gone).toBeUndefined();
    });

    it("is refused for a base, which never comes back cut short", async () => {
      const own = (await insertBase(db, owner, { name: "Gone" })).id;
      const first = await table(own);
      const second = await table(own);
      await trashBase(db, owner, own);
      const held = await hold(first.physicalName);
      const other = await hold(second.physicalName);
      const purge = purgeItem(deps(), {
        kind: "base",
        id: own,
        actorId: owner,
      });
      const deadline = Date.now() + 10_000;
      for (;;) {
        const { rows } = await sql<{ waiting: string }>`
          select count(*)::text as waiting from pg_stat_activity
          where wait_event_type = 'Lock' and query ilike '%drop table%'
        `.execute(db);
        if (rows[0]?.waiting !== "0") break;
        if (Date.now() > deadline) throw new Error("no drop reached");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(await code(restoreBase(db, owner, own))).toBe("no_row");
      await held.release();
      await other.release();
      expect(await purge).toBe(true);
      const left = await db
        .selectFrom("bases")
        .select("id")
        .where("id", "=", own)
        .executeTakeFirst();
      expect(left).toBeUndefined();
    });
  });

  describe("a purge that stopped halfway", () => {
    async function reserved(minutesAgo: number) {
      const item = await table();
      await trashTable(db, owner, item);
      await withAudit(db, { userId: owner, source: "purge" }, (tx) =>
        tx
          .updateTable("dataTables")
          .set({
            purgeStartedAt: new Date(Date.now() - minutesAgo * 60_000),
          })
          .where("id", "=", item.id)
          .execute(),
      );
      return item;
    }

    it("can no longer be restored, and leaves the trash's list", async () => {
      const item = await reserved(1);
      expect(await code(restoreTable(db, owner, item.id))).toBe("no_row");
      const listed = await listTrash(db, baseId, owner);
      expect(listed.map((entry) => entry.id)).not.toContain(item.id);
      expect(await stillThere(item.physicalName)).toBe(true);
    });

    it("is not taken over while another purge may still be running", async () => {
      const item = await reserved(1);
      expect(
        await purgeItem(deps(), { kind: "table", id: item.id, actorId: owner }),
      ).toBe(false);
      expect(await stillThere(item.physicalName)).toBe(true);
    });

    it("is finished by the next pass, whatever the trash's retention", async () => {
      const item = await reserved(7 * 60);
      const due = await dueTrashItems(db, new Date());
      expect(due.map((entry) => entry.id)).toContain(item.id);
      expect(
        await purgeItem(deps(), { kind: "table", id: item.id, actorId: owner }),
      ).toBe(true);
      expect(await stillThere(item.physicalName)).toBe(false);
    });

    it("hides a base being purged from the list of those to restore", async () => {
      const own = (await insertBase(db, owner, { name: "Half" })).id;
      await trashBase(db, owner, own);
      await withAudit(db, { userId: owner, source: "purge" }, (tx) =>
        tx
          .updateTable("bases")
          .set({ purgeStartedAt: new Date() })
          .where("id", "=", own)
          .execute(),
      );
      const listed = await listTrashedBases(db, [own]);
      expect(listed).toEqual([]);
      expect(await code(restoreBase(db, owner, own))).toBe("no_row");
    });
  });

  it("does not leave a reservation behind a refused schema drop", async () => {
    const own = (await insertBase(db, owner, { name: "Schema" })).id;
    await trashBase(db, owner, own);
    expect(
      await code(
        purgeItem(deps(), {
          kind: "base",
          id: own,
          actorId: owner,
          dropSchema: "not_this_one",
        }),
      ),
    ).toBe("invalid_arguments");
    await restoreBase(db, owner, own);
    const { tables } = await loadCatalogRows(db, []);
    expect(Array.isArray(tables)).toBe(true);
  });
});
