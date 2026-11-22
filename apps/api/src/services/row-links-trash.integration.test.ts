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
import { createRecords, updateRecords } from "../public-api/operations.js";
import type { Actor, PublicApiDeps } from "../public-api/types.js";
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

  describe("a link edited from either side", () => {
    const sealed = ["locked", "signed"] as const;

    async function inverseName(id: string | null): Promise<string> {
      const column = await db
        .selectFrom("dataColumns")
        .select("name")
        .where("id", "=", id ?? "")
        .executeTakeFirstOrThrow();
      return column.name;
    }

    /** Refused, and neither side's links nor the sealed row's history moved. */
    async function refusedUnchanged(
      edit: () => Promise<unknown>,
      watched: {
        tableId: string;
        rowId: string;
        column: string;
      },
    ) {
      const links = await linked(
        watched.tableId,
        watched.rowId,
        watched.column,
      );
      const trail = (await events(watched.tableId, watched.rowId)).length;
      expect(await refusal(edit())).toBe("row_locked");
      expect(
        await linked(watched.tableId, watched.rowId, watched.column),
      ).toEqual(links);
      expect((await events(watched.tableId, watched.rowId)).length).toBe(trail);
    }

    it.each(sealed)(
      "many-to-many, from the inverse side: keeps a %s source as it is",
      async (status) => {
        const { target, sources, targetRow, source, relation } =
          await manyToMany(true);
        const inverse = await inverseName(relation.inverseId);
        const free = await row(sources, "free");
        await seal(sources, source, status);
        const watched = { tableId: sources, rowId: source, column: "items" };
        // Taking the sealed row out, by the list and by difference.
        await refusedUnchanged(
          () => link(target, targetRow, inverse, [free]),
          watched,
        );
        await refusedUnchanged(
          async () =>
            replaceLinks(
              deps(),
              await scopeOf(target),
              targetRow,
              { column: inverse, add: [], remove: [source] },
              meta,
            ),
          watched,
        );
        // Putting it on another target.
        const other = await row(target, "other");
        await refusedUnchanged(
          () => link(target, other, inverse, [source]),
          watched,
        );
      },
    );

    it.each(sealed)(
      "many-to-many, from the forward side: keeps a %s target that lists it",
      async (status) => {
        const { target, sources, targetRow, source, relation } =
          await manyToMany(true);
        const inverse = await inverseName(relation.inverseId);
        const second = await row(sources, "second");
        await seal(target, targetRow, status);
        const watched = { tableId: target, rowId: targetRow, column: inverse };
        await refusedUnchanged(
          () => link(sources, source, "items", []),
          watched,
        );
        await refusedUnchanged(
          () => link(sources, second, "items", [targetRow]),
          watched,
        );
        await refusedUnchanged(
          async () =>
            replaceLinks(
              deps(),
              await scopeOf(sources),
              second,
              { column: "items", add: [targetRow], remove: [] },
              meta,
            ),
          watched,
        );
      },
    );

    it.each(sealed)(
      "one-to-many, from the forward side: keeps a %s target that lists it",
      async (status) => {
        const { target, holders, targetRow, holder, relation } =
          await oneToMany(true);
        const inverse = await inverseName(relation.inverseId);
        const other = await row(target, "other");
        const second = await row(holders, "second");
        await seal(target, targetRow, status);
        const watched = { tableId: target, rowId: targetRow, column: inverse };
        await refusedUnchanged(
          () => link(holders, holder, "parent", []),
          watched,
        );
        await refusedUnchanged(
          () => link(holders, holder, "parent", [other]),
          watched,
        );
        await refusedUnchanged(
          () => link(holders, second, "parent", [targetRow]),
          watched,
        );
      },
    );

    it.each(sealed)(
      "one-to-many, from the inverse side: keeps a %s holder as it is",
      async (status) => {
        const { target, holders, targetRow, holder, relation } =
          await oneToMany(true);
        const inverse = await inverseName(relation.inverseId);
        const other = await row(target, "other");
        await seal(holders, holder, status);
        const watched = { tableId: holders, rowId: holder, column: "parent" };
        await refusedUnchanged(
          () => link(target, targetRow, inverse, []),
          watched,
        );
        await refusedUnchanged(
          () => link(target, other, inverse, [holder]),
          watched,
        );
      },
    );

    it.each(sealed)(
      "one-to-many: does not take a holder away from a %s row",
      async (status) => {
        const { target, holders, targetRow, holder, relation } =
          await oneToMany(true);
        const inverse = await inverseName(relation.inverseId);
        const other = await row(target, "other");
        await seal(target, targetRow, status);
        await refusedUnchanged(() => link(target, other, inverse, [holder]), {
          tableId: target,
          rowId: targetRow,
          column: inverse,
        });
        expect(await linked(holders, holder, "parent")).toEqual([targetRow]);
      },
    );

    it("writes nothing on a sealed row when the list does not change it", async () => {
      const { target, sources, targetRow, source, relation } =
        await manyToMany(true);
      const inverse = await inverseName(relation.inverseId);
      const free = await row(sources, "free");
      await seal(sources, source, "signed");
      const trail = (await events(sources, source)).length;
      await link(target, targetRow, inverse, [source, free]);
      expect(await linked(sources, source, "items")).toEqual([targetRow]);
      expect(await linked(sources, free, "items")).toEqual([targetRow]);
      expect((await events(sources, source)).length).toBe(trail);
    });

    it("still links a row to the signed target of a one-way link", async () => {
      const { target, sources, targetRow } = await manyToMany();
      await seal(target, targetRow, "signed");
      const second = await row(sources, "second");
      await link(sources, second, "items", [targetRow]);
      expect(await linked(sources, second, "items")).toEqual([targetRow]);
      await link(sources, second, "items", []);
      expect(await linked(sources, second, "items")).toEqual([]);
    });

    it("writes the change in the history of an unlocked row, many-to-many", async () => {
      const { target, sources, targetRow, source, relation } =
        await manyToMany(true);
      const inverse = await inverseName(relation.inverseId);
      const before = (await events(sources, source)).length;
      await link(target, targetRow, inverse, []);
      const removed = await events(sources, source);
      expect(removed.length).toBe(before + 1);
      expect(removed[0]?.oldValue).toEqual({ items: [targetRow] });
      expect(removed[0]?.newValue).toEqual({ items: [] });
      await link(target, targetRow, inverse, [source]);
      const added = await events(sources, source);
      expect(added.length).toBe(before + 2);
      expect(added[0]?.oldValue).toEqual({ items: [] });
      expect(added[0]?.newValue).toEqual({ items: [targetRow] });
      const targetTrail = await events(target, targetRow);
      expect(targetTrail[0]?.newValue).toEqual({ [inverse]: [source] });
    });

    it("writes the change in the history of an unlocked target, one-to-many", async () => {
      const { target, holders, targetRow, holder, relation } =
        await oneToMany(true);
      const inverse = await inverseName(relation.inverseId);
      const other = await row(target, "other");
      const left = (await events(target, targetRow)).length;
      const joined = (await events(target, other)).length;
      await link(holders, holder, "parent", [other]);
      const fromOld = await events(target, targetRow);
      const toNew = await events(target, other);
      expect(fromOld.length).toBe(left + 1);
      expect(fromOld[0]?.oldValue).toEqual({ [inverse]: [holder] });
      expect(fromOld[0]?.newValue).toEqual({ [inverse]: [] });
      expect(toNew.length).toBe(joined + 1);
      expect(toNew[0]?.oldValue).toEqual({ [inverse]: [] });
      expect(toNew[0]?.newValue).toEqual({ [inverse]: [holder] });
    });

    it("writes the move in the history of the row a holder leaves", async () => {
      const { target, targetRow, holder, relation } = await oneToMany(true);
      const inverse = await inverseName(relation.inverseId);
      const other = await row(target, "other");
      const left = (await events(target, targetRow)).length;
      await link(target, other, inverse, [holder]);
      const fromOld = await events(target, targetRow);
      expect(fromOld.length).toBe(left + 1);
      expect(fromOld[0]?.oldValue).toEqual({ [inverse]: [holder] });
      expect(fromOld[0]?.newValue).toEqual({ [inverse]: [] });
    });

    it("leaves no new row behind a link it refuses", async () => {
      const { target, sources, targetRow } = await manyToMany(true);
      await seal(target, targetRow, "signed");
      const count = async () => (await readAllIds(sources)).length;
      const before = await count();
      expect(
        await refusal(
          (async () =>
            createRows(
              deps(),
              await scopeOf(sources),
              [
                {
                  values: { label: "new" },
                  links: [{ column: "items", targetIds: [targetRow] }],
                },
              ],
              meta,
            ))(),
        ),
      ).toBe("row_locked");
      expect(await count()).toBe(before);
    });

    async function readAllIds(tableId: string): Promise<string[]> {
      const found = await findLiveTable(db, tableId);
      if (!found) throw new Error("no table");
      const { rows } = await sql<{ id: string }>`
        select id from ${sql.table(found.physicalName)}
      `.execute(db);
      return rows.map((item) => item.id);
    }

    describe("through the public API", () => {
      const api = (): PublicApiDeps => ({
        db,
        bus: recorder.bus,
        publicUrl: "https://grid.example.org",
        log: () => undefined,
      });
      const caller = async (): Promise<Actor> => ({
        user: {
          id: owner,
          email: `owner-${suffix}@example.com`,
          displayName: "Owner",
          isAdmin: false,
          isSupport: false,
          isAuditor: false,
        },
        bindings: await loadBindings(db, owner),
      });

      it("refuses an update that would change a signed row", async () => {
        const { target, sources, targetRow, source, relation } =
          await manyToMany(true);
        const inverse = await inverseName(relation.inverseId);
        await seal(sources, source, "signed");
        await refusedUnchanged(
          async () =>
            updateRecords(api(), await caller(), target, {
              records: [{ id: targetRow, fields: { [inverse]: [] } }],
            }),
          { tableId: sources, rowId: source, column: "items" },
        );
      });

      it("refuses a new record linked to a signed row, and keeps none", async () => {
        const { target, sources, targetRow, relation } = await manyToMany(true);
        const inverse = await inverseName(relation.inverseId);
        await seal(target, targetRow, "signed");
        const before = (await readAllIds(sources)).length;
        await refusedUnchanged(
          async () =>
            createRecords(api(), await caller(), sources, {
              records: [{ fields: { label: "new", items: [targetRow] } }],
            }),
          { tableId: target, rowId: targetRow, column: inverse },
        );
        expect((await readAllIds(sources)).length).toBe(before);
      });

      it("takes the same edit once the other side is a draft", async () => {
        const { target, sources, targetRow, source, relation } =
          await manyToMany(true);
        const inverse = await inverseName(relation.inverseId);
        await updateRecords(api(), await caller(), target, {
          records: [{ id: targetRow, fields: { [inverse]: [] } }],
        });
        expect(await linked(sources, source, "items")).toEqual([]);
      });
    });
  });

  describe("two linked rows, both in the trash", () => {
    it("gets a one-to-many link back when the holder returns first", async () => {
      const { target, holders, targetRow, holder } = await oneToMany();
      await deleteRows(deps(), await scopeOf(holders), [holder], meta);
      await deleteRows(deps(), await scopeOf(target), [targetRow], meta);
      await restoreRows(deps(), await scopeOf(holders), [holder], meta);
      expect(await linked(holders, holder, "parent")).toEqual([]);
      const back = await restoreRows(
        deps(),
        await scopeOf(target),
        [targetRow],
        meta,
      );
      expect(back.linksNotRestored).toBe(0);
      expect(await linked(holders, holder, "parent")).toEqual([targetRow]);
    });

    it("gets it back when the target was deleted first and returns first", async () => {
      const { target, holders, targetRow, holder } = await oneToMany();
      await deleteRows(deps(), await scopeOf(target), [targetRow], meta);
      await deleteRows(deps(), await scopeOf(holders), [holder], meta);
      await restoreRows(deps(), await scopeOf(target), [targetRow], meta);
      await restoreRows(deps(), await scopeOf(holders), [holder], meta);
      expect(await linked(holders, holder, "parent")).toEqual([targetRow]);
    });

    it("gets a many-to-many link back in either order", async () => {
      for (const first of ["target", "source"]) {
        const { target, sources, targetRow, source } = await manyToMany();
        await deleteRows(deps(), await scopeOf(target), [targetRow], meta);
        await deleteRows(deps(), await scopeOf(sources), [source], meta);
        if (first === "target") {
          await restoreRows(deps(), await scopeOf(target), [targetRow], meta);
          await restoreRows(deps(), await scopeOf(sources), [source], meta);
        } else {
          await restoreRows(deps(), await scopeOf(sources), [source], meta);
          await restoreRows(deps(), await scopeOf(target), [targetRow], meta);
        }
        expect(await linked(sources, source, "items")).toEqual([targetRow]);
      }
    });

    it("leaves a key set meanwhile, and a holder locked meanwhile", async () => {
      const first = await oneToMany();
      const other = await row(first.target, "other");
      await deleteRows(
        deps(),
        await scopeOf(first.holders),
        [first.holder],
        meta,
      );
      await deleteRows(
        deps(),
        await scopeOf(first.target),
        [first.targetRow],
        meta,
      );
      await restoreRows(
        deps(),
        await scopeOf(first.holders),
        [first.holder],
        meta,
      );
      await link(first.holders, first.holder, "parent", [other]);
      await restoreRows(
        deps(),
        await scopeOf(first.target),
        [first.targetRow],
        meta,
      );
      expect(await linked(first.holders, first.holder, "parent")).toEqual([
        other,
      ]);

      const second = await oneToMany();
      await deleteRows(
        deps(),
        await scopeOf(second.holders),
        [second.holder],
        meta,
      );
      await deleteRows(
        deps(),
        await scopeOf(second.target),
        [second.targetRow],
        meta,
      );
      await restoreRows(
        deps(),
        await scopeOf(second.holders),
        [second.holder],
        meta,
      );
      await seal(second.holders, second.holder, "locked");
      const back = await restoreRows(
        deps(),
        await scopeOf(second.target),
        [second.targetRow],
        meta,
      );
      expect(back.linksNotRestored).toBe(1);
      expect(await linked(second.holders, second.holder, "parent")).toEqual([]);
    });

    it("gets back every link of a target whose holders return one by one", async () => {
      const target = await table("Target");
      const holders = await table("Holders");
      await addRelation(db, owner, {
        tableId: holders,
        name: "parent",
        kind: "one_to_many",
        targetTableId: target,
      });
      const targetRow = await row(target, "target");
      const many: string[] = [];
      for (let index = 0; index < 12; index += 1) {
        const id = await row(holders, `h${index}`);
        await link(holders, id, "parent", [targetRow]);
        many.push(id);
      }
      await deleteRows(deps(), await scopeOf(holders), many, meta);
      await deleteRows(deps(), await scopeOf(target), [targetRow], meta);
      for (const id of many) {
        await restoreRows(deps(), await scopeOf(holders), [id], meta);
      }
      await restoreRows(deps(), await scopeOf(target), [targetRow], meta);
      for (const id of many) {
        expect(await linked(holders, id, "parent")).toEqual([targetRow]);
      }
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
