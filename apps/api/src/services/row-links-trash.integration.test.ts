/**
 * A row's links through the trash, against a real database: what a delete
 * takes from the rows linked to it, what it refuses, and what a restore
 * brings back.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { AppError, setLinksInputSchema } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadBindings } from "../auth/access.js";
import { runRows, withAudit } from "../data/audit-context.js";
import { addRelation } from "../data/relations.js";
import { readAudit, readByIds, setRowStatus, signRow } from "../data/rows.js";
import { insertBase, insertTable } from "../data/schema-ops.js";
import { recoverTrashedLinks } from "../data/trash-links.js";
import { recordingBus } from "../realtime/recording-bus.test-helpers.js";
import { createTestDatabase } from "../test-database.js";
import {
  createRows,
  deleteRows,
  findLiveTable,
  loadRowScope,
  replaceLinks,
  restoreRows,
  type RowScope,
} from "./rows.js";

const suffix = randomBytes(6).toString("hex");
const meta = { source: "web" };

describe("a row's links through the trash", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let owner = "";
  let baseId = "";
  const recorder = recordingBus();
  const deps = () => ({ db, bus: recorder.bus, log: () => undefined });

  beforeAll(async () => {
    const created = await createTestDatabase("row_links_trash");
    db = created.db;
    close = created.close;
    const [person] = await db
      .insertInto("users")
      .values([{ email: `owner-${suffix}@example.com`, displayName: "Owner" }])
      .returning("id")
      .execute();
    owner = person?.id ?? "";
    baseId = (await insertBase(db, owner, { name: "Links" })).id;
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  async function table(name: string): Promise<string> {
    const made = await insertTable(db, owner, {
      baseId,
      name: `${name} ${randomBytes(3).toString("hex")}`,
      columns: [{ name: "label", label: "Label", fieldType: "text" }],
    });
    return made.id;
  }

  async function scopeOf(tableId: string): Promise<RowScope> {
    const found = await findLiveTable(db, tableId);
    if (!found) throw new Error("no table");
    return loadRowScope(
      db,
      { userId: owner, bindings: await loadBindings(db, owner) },
      found,
    );
  }

  async function row(tableId: string, label: string): Promise<string> {
    const [id] = await createRows(
      deps(),
      await scopeOf(tableId),
      [{ values: { label } }],
      meta,
    );
    if (!id) throw new Error("no row");
    return id;
  }

  async function link(
    tableId: string,
    rowId: string,
    column: string,
    targetIds: string[],
  ): Promise<void> {
    await replaceLinks(
      deps(),
      await scopeOf(tableId),
      rowId,
      { column, targetIds },
      meta,
    );
  }

  async function linked(
    tableId: string,
    rowId: string,
    column: string,
  ): Promise<string[]> {
    const [read] = await readByIds(
      db,
      (await scopeOf(tableId)).engine,
      [rowId],
      "UTC",
    );
    const cell = read?.[column];
    return Array.isArray(cell)
      ? cell.map((item) => String((item as { id: unknown }).id))
      : [];
  }

  async function seal(
    tableId: string,
    rowId: string,
    to: "locked" | "signed",
  ): Promise<void> {
    const found = await findLiveTable(db, tableId);
    if (!found) throw new Error("no table");
    for (const status of ["submitted", "locked"] as const) {
      await setRowStatus(db, {
        userId: owner,
        role: "owner",
        table: found,
        rowId,
        status,
      });
    }
    if (to === "signed") {
      await signRow(db, {
        userId: owner,
        table: found,
        rowId,
        meaning: "Approved",
      });
    }
  }

  async function events(tableId: string, rowId: string) {
    return readAudit(db, tableId, rowId);
  }

  async function refusal(write: Promise<unknown>): Promise<string> {
    try {
      await write;
    } catch (error) {
      if (error instanceof AppError) return error.code;
      throw error;
    }
    return "written";
  }

  /** A target, a table holding a one-to-many link to it, and one holder. */
  async function oneToMany(twoWay = false) {
    const target = await table("Target");
    const holders = await table("Holders");
    const relation = await addRelation(db, owner, {
      tableId: holders,
      name: "parent",
      kind: "one_to_many",
      targetTableId: target,
      twoWay,
    });
    const targetRow = await row(target, "target");
    const holder = await row(holders, "holder");
    await link(holders, holder, "parent", [targetRow]);
    return { target, holders, targetRow, holder, relation };
  }

  async function manyToMany(twoWay = false) {
    const target = await table("Target");
    const sources = await table("Sources");
    const relation = await addRelation(db, owner, {
      tableId: sources,
      name: "items",
      kind: "many_to_many",
      targetTableId: target,
      twoWay,
    });
    const targetRow = await row(target, "target");
    const source = await row(sources, "source");
    await link(sources, source, "items", [targetRow]);
    return { target, sources, targetRow, source, relation };
  }

  describe("a one-to-many link", () => {
    it("comes back with the row it pointed to", async () => {
      const { target, holders, targetRow, holder } = await oneToMany();
      await deleteRows(deps(), await scopeOf(target), [targetRow], meta);
      expect(await linked(holders, holder, "parent")).toEqual([]);
      const restored = await restoreRows(
        deps(),
        await scopeOf(target),
        [targetRow],
        meta,
      );
      expect(restored.ids).toEqual([targetRow]);
      expect(restored.linksNotRestored).toBe(0);
      expect(await linked(holders, holder, "parent")).toEqual([targetRow]);
    });

    it("shows the removal and the return in the holder's own history", async () => {
      const { target, holders, targetRow, holder } = await oneToMany();
      const before = (await events(holders, holder)).length;
      await deleteRows(deps(), await scopeOf(target), [targetRow], meta);
      const removed = await events(holders, holder);
      expect(removed.length).toBe(before + 1);
      expect(removed[0]?.action).toBe("update");
      expect((removed[0]?.oldValue as Record<string, unknown>).parent).toBe(
        targetRow,
      );
      expect((removed[0]?.newValue as Record<string, unknown>).parent).toBe(
        null,
      );
      await restoreRows(deps(), await scopeOf(target), [targetRow], meta);
      const back = await events(holders, holder);
      expect(back.length).toBe(before + 2);
      expect((back[0]?.newValue as Record<string, unknown>).parent).toBe(
        targetRow,
      );
    });

    it("files no event of the holder under the deleted row's table", async () => {
      const { target, targetRow, holder } = await oneToMany();
      await deleteRows(deps(), await scopeOf(target), [targetRow], meta);
      const stray = await db
        .selectFrom("auditEvents")
        .select("id")
        .where("tableId", "=", target)
        .where("recordId", "=", holder)
        .execute();
      expect(stray).toEqual([]);
    });

    it("leaves alone a link set again while the row was away", async () => {
      const { target, holders, targetRow, holder } = await oneToMany();
      const other = await row(target, "other");
      await deleteRows(deps(), await scopeOf(target), [targetRow], meta);
      await link(holders, holder, "parent", [other]);
      const restored = await restoreRows(
        deps(),
        await scopeOf(target),
        [targetRow],
        meta,
      );
      expect(await linked(holders, holder, "parent")).toEqual([other]);
      expect(restored.linksNotRestored).toBe(0);
    });

    it("does not write to a holder locked since, and says so", async () => {
      const { target, holders, targetRow, holder } = await oneToMany();
      await deleteRows(deps(), await scopeOf(target), [targetRow], meta);
      await seal(holders, holder, "locked");
      const restored = await restoreRows(
        deps(),
        await scopeOf(target),
        [targetRow],
        meta,
      );
      expect(restored.ids).toEqual([targetRow]);
      expect(restored.linksNotRestored).toBe(1);
      expect(await linked(holders, holder, "parent")).toEqual([]);
    });

    it.each(["locked", "signed"] as const)(
      "refuses to delete a row a %s row points to",
      async (status) => {
        const { target, holders, targetRow, holder } = await oneToMany();
        await seal(holders, holder, status);
        const trail = (await events(holders, holder)).length;
        expect(
          await refusal(
            deleteRows(deps(), await scopeOf(target), [targetRow], meta),
          ),
        ).toBe("row_locked");
        expect(await linked(holders, holder, "parent")).toEqual([targetRow]);
        expect((await events(holders, holder)).length).toBe(trail);
      },
    );

    it("refuses to delete a row whose parent shows it and is signed", async () => {
      const { target, holders, targetRow, holder, relation } =
        await oneToMany(true);
      await seal(target, targetRow, "signed");
      expect(
        await refusal(
          deleteRows(deps(), await scopeOf(holders), [holder], meta),
        ),
      ).toBe("row_locked");
      const inverse = await db
        .selectFrom("dataColumns")
        .select("name")
        .where("id", "=", relation.inverseId ?? "")
        .executeTakeFirstOrThrow();
      expect(await linked(target, targetRow, inverse.name)).toEqual([holder]);
    });

    it("restores a holder and its target deleted together, in either order", async () => {
      for (const order of ["target first", "holder first"]) {
        const { target, holders, targetRow, holder } = await oneToMany();
        if (order === "target first") {
          await deleteRows(deps(), await scopeOf(target), [targetRow], meta);
          await deleteRows(deps(), await scopeOf(holders), [holder], meta);
          await restoreRows(deps(), await scopeOf(holders), [holder], meta);
          await restoreRows(deps(), await scopeOf(target), [targetRow], meta);
        } else {
          await deleteRows(deps(), await scopeOf(holders), [holder], meta);
          await deleteRows(deps(), await scopeOf(target), [targetRow], meta);
          await restoreRows(deps(), await scopeOf(target), [targetRow], meta);
          await restoreRows(deps(), await scopeOf(holders), [holder], meta);
        }
        expect(await linked(holders, holder, "parent")).toEqual([targetRow]);
      }
    });

    it("restores a holder whose target is still in the trash, without its key", async () => {
      const { target, holders, targetRow, holder } = await oneToMany();
      await deleteRows(deps(), await scopeOf(holders), [holder], meta);
      await deleteRows(deps(), await scopeOf(target), [targetRow], meta);
      const restored = await restoreRows(
        deps(),
        await scopeOf(holders),
        [holder],
        meta,
      );
      expect(restored.ids).toEqual([holder]);
      expect(await linked(holders, holder, "parent")).toEqual([]);
    });

    it("keeps two rows of one table linked when both are deleted at once", async () => {
      const own = await table("Tree");
      await addRelation(db, owner, {
        tableId: own,
        name: "parent",
        kind: "one_to_many",
        targetTableId: own,
      });
      const top = await row(own, "top");
      const leaf = await row(own, "leaf");
      await link(own, leaf, "parent", [top]);
      for (const ids of [
        [top, leaf],
        [leaf, top],
      ]) {
        await deleteRows(deps(), await scopeOf(own), ids, meta);
        await restoreRows(deps(), await scopeOf(own), ids, meta);
        expect(await linked(own, leaf, "parent")).toEqual([top]);
      }
    });
  });

  describe("a many-to-many link", () => {
    it.each(["locked", "signed"] as const)(
      "refuses to delete a row a %s row is linked to",
      async (status) => {
        const { target, sources, targetRow, source } = await manyToMany();
        await seal(sources, source, status);
        const trail = (await events(sources, source)).length;
        expect(
          await refusal(
            deleteRows(deps(), await scopeOf(target), [targetRow], meta),
          ),
        ).toBe("row_locked");
        expect(await linked(sources, source, "items")).toEqual([targetRow]);
        expect((await events(sources, source)).length).toBe(trail);
      },
    );

    it("writes the removal and the return on the linked row", async () => {
      const { target, sources, targetRow, source } = await manyToMany();
      const before = (await events(sources, source)).length;
      await deleteRows(deps(), await scopeOf(target), [targetRow], meta);
      const removed = await events(sources, source);
      expect(removed.length).toBe(before + 1);
      expect(removed[0]?.oldValue).toEqual({ items: [targetRow] });
      expect(removed[0]?.newValue).toEqual({ items: [] });
      await restoreRows(deps(), await scopeOf(target), [targetRow], meta);
      expect(await linked(sources, source, "items")).toEqual([targetRow]);
      const back = await events(sources, source);
      expect(back.length).toBe(before + 2);
      expect(back[0]?.oldValue).toEqual({ items: [] });
      expect(back[0]?.newValue).toEqual({ items: [targetRow] });
    });

    it("lets a row go when the one it points to shows nothing of it", async () => {
      const { target, sources, targetRow, source } = await manyToMany();
      await seal(target, targetRow, "signed");
      await deleteRows(deps(), await scopeOf(sources), [source], meta);
      await restoreRows(deps(), await scopeOf(sources), [source], meta);
      expect(await linked(sources, source, "items")).toEqual([targetRow]);
    });

    it("refuses when the row on the other side of a two-way link is signed", async () => {
      const { target, sources, targetRow, source } = await manyToMany(true);
      await seal(target, targetRow, "signed");
      expect(
        await refusal(
          deleteRows(deps(), await scopeOf(sources), [source], meta),
        ),
      ).toBe("row_locked");
    });

    it("does not link a row locked since, and says so", async () => {
      const { target, sources, targetRow, source } = await manyToMany();
      await deleteRows(deps(), await scopeOf(target), [targetRow], meta);
      await seal(sources, source, "locked");
      const restored = await restoreRows(
        deps(),
        await scopeOf(target),
        [targetRow],
        meta,
      );
      expect(restored.linksNotRestored).toBe(1);
      expect(await linked(sources, source, "items")).toEqual([]);
    });
  });

  describe("rows already in the trash", () => {
    /** What a delete did before it kept its holders: the key cleared by the database. */
    async function deletedBefore(tableId: string, rowId: string) {
      const found = await findLiveTable(db, tableId);
      if (!found) throw new Error("no table");
      await withAudit(db, { userId: owner, tableId, source: "web" }, (tx) =>
        runRows(tx, {
          text: `delete from "${found.physicalName}" where id = $1`,
          values: [rowId],
        }),
      );
    }

    it("are caught up only when asked, and only once", async () => {
      const { target, holders, targetRow, holder } = await oneToMany();
      await deletedBefore(target, targetRow);
      expect(await linked(holders, holder, "parent")).toEqual([]);

      const dry = await recoverTrashedLinks(db, { dryRun: true });
      expect(dry.links).toBeGreaterThanOrEqual(1);
      expect(dry.written).toBe(0);
      const trail = await db
        .selectFrom("auditEvents")
        .select("id")
        .where("tableId", "=", target)
        .where("recordId", "=", targetRow)
        .execute();
      expect(trail).toHaveLength(2);

      const real = await recoverTrashedLinks(db, { dryRun: false });
      expect(real.written).toBeGreaterThanOrEqual(1);
      const again = await recoverTrashedLinks(db, { dryRun: false });
      expect(again.written).toBe(0);

      const restored = await restoreRows(
        deps(),
        await scopeOf(target),
        [targetRow],
        meta,
      );
      expect(restored.linksNotRestored).toBe(0);
      expect(await linked(holders, holder, "parent")).toEqual([targetRow]);
    });

    it("are not touched when a restore comes without the command", async () => {
      const { target, holders, targetRow, holder } = await oneToMany();
      await deletedBefore(target, targetRow);
      await restoreRows(deps(), await scopeOf(target), [targetRow], meta);
      expect(await linked(holders, holder, "parent")).toEqual([]);
    });

    it("keep their marker out of the history", async () => {
      const { target, targetRow } = await oneToMany();
      await deletedBefore(target, targetRow);
      await recoverTrashedLinks(db, { dryRun: false });
      const shown = await events(target, targetRow);
      expect(shown.map((event) => event.action)).toEqual(["delete", "insert"]);
    });
  });

  describe("links changed by difference", () => {
    /** A hub with 501 rows linked, written directly for speed. */
    async function hub() {
      const target = await table("Hub");
      const sources = await table("Spokes");
      const relation = await addRelation(db, owner, {
        tableId: sources,
        name: "hubs",
        kind: "many_to_many",
        targetTableId: target,
        twoWay: true,
      });
      const inverse = await db
        .selectFrom("dataColumns")
        .select("name")
        .where("id", "=", relation.inverseId ?? "")
        .executeTakeFirstOrThrow();
      const hubRow = await row(target, "hub");
      const scope = await scopeOf(sources);
      const spokes = await createRows(
        deps(),
        scope,
        Array.from({ length: 501 }, (_, index) => ({
          values: { label: `s${index}` },
        })),
        meta,
      );
      const junction = await db
        .selectFrom("relations")
        .select("junctionName")
        .where("fromColumnId", "=", relation.id)
        .executeTakeFirstOrThrow();
      await sql`
        insert into ${sql.table(junction.junctionName ?? "")} (left_id, right_id)
        select unnest(${spokes}::uuid[]), ${hubRow}::uuid
      `.execute(db);
      return { target, sources, hubRow, spokes, inverse: inverse.name };
    }

    it("adds and removes one link on a row holding more than the list limit", async () => {
      const { target, sources, hubRow, spokes, inverse } = await hub();
      expect(await linked(target, hubRow, inverse)).toHaveLength(501);
      const extra = await row(sources, "extra");
      await replaceLinks(
        deps(),
        await scopeOf(target),
        hubRow,
        { column: inverse, add: [extra], remove: [spokes[0] ?? ""] },
        meta,
      );
      const after = await linked(target, hubRow, inverse);
      expect(after).toHaveLength(501);
      expect(after).toContain(extra);
      expect(after).not.toContain(spokes[0]);
    });

    it("writes the change on the row's history", async () => {
      const { target, sources, hubRow, spokes, inverse } = await hub();
      const extra = await row(sources, "extra");
      await replaceLinks(
        deps(),
        await scopeOf(target),
        hubRow,
        { column: inverse, add: [extra], remove: [spokes[1] ?? ""] },
        meta,
      );
      const [event] = await events(target, hubRow);
      const before = (event?.oldValue as Record<string, string[]>)[inverse];
      const after = (event?.newValue as Record<string, string[]>)[inverse];
      expect(before).toHaveLength(501);
      expect(after).toHaveLength(501);
      expect(after).toContain(extra);
    });

    it("refuses a change on a locked row", async () => {
      const { target, hubRow, spokes, inverse } = await hub();
      await seal(target, hubRow, "locked");
      expect(
        await refusal(
          (async () =>
            replaceLinks(
              deps(),
              await scopeOf(target),
              hubRow,
              { column: inverse, add: [], remove: [spokes[0] ?? ""] },
              meta,
            ))(),
        ),
      ).toBe("row_locked");
    });

    it("refuses a row that does not exist", async () => {
      const { target, hubRow, inverse } = await hub();
      expect(
        await refusal(
          (async () =>
            replaceLinks(
              deps(),
              await scopeOf(target),
              hubRow,
              { column: inverse, add: [randomUUID()], remove: [] },
              meta,
            ))(),
        ),
      ).toBe("unknown_row");
    });

    it("keeps its limit, and one form per request", () => {
      const base = {
        tableId: randomUUID(),
        rowId: randomUUID(),
        column: "links",
      };
      const ids = (count: number) =>
        Array.from({ length: count }, () => randomUUID());
      expect(
        setLinksInputSchema.safeParse({ ...base, add: ids(500) }).success,
      ).toBe(true);
      expect(
        setLinksInputSchema.safeParse({ ...base, add: ids(501) }).success,
      ).toBe(false);
      expect(
        setLinksInputSchema.safeParse({ ...base, remove: ids(501) }).success,
      ).toBe(false);
      expect(
        setLinksInputSchema.safeParse({ ...base, targetIds: ids(501) }).success,
      ).toBe(false);
      expect(
        setLinksInputSchema.safeParse({
          ...base,
          targetIds: ids(1),
          add: ids(1),
        }).success,
      ).toBe(false);
      expect(setLinksInputSchema.safeParse(base).success).toBe(false);
      const same = randomUUID();
      expect(
        setLinksInputSchema.safeParse({ ...base, add: [same], remove: [same] })
          .success,
      ).toBe(false);
      expect(
        setLinksInputSchema.safeParse({ ...base, add: [same, same] }).success,
      ).toBe(false);
    });
  });
});
