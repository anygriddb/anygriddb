/**
 * A row rule holds for what a row becomes, as for what it was, on a
 * migrated database: a writer neither creates a row outside it nor pushes
 * one out, and a refused write leaves nothing behind (ADR 0112).
 */
import { loadBindings } from "../auth/access.js";
import { setMemberRole } from "../data/members.js";
import { setTableRole } from "../data/sharing.js";
import { randomBytes } from "node:crypto";
import { runStatement, type Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { narrowOn } from "../data/rules.test-helpers.js";
import { importIntoTable, rowsSource } from "../data/import-commit.js";
import { addRelation } from "../data/relations.js";
import { insertBase, insertTable } from "../data/schema-ops.js";
import { recordingBus } from "../realtime/recording-bus.test-helpers.js";
import { createTestDatabase } from "../test-database.js";
import {
  createRows,
  findLiveTable,
  loadRowScope,
  replaceLinks,
  updateRows,
} from "./rows.js";

const suffix = randomBytes(6).toString("hex");
const { bus } = recordingBus();
const META = { source: "test" };

describe("a row rule on what is written", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let owner = "";
  let editor = "";
  let baseId = "";
  let tableId = "";
  let linkedId = "";
  let linkTable = "";
  let target = "";
  let other = "";
  let dealsId = "";

  const deps = () => ({ db, bus, log: () => undefined });
  // Read as each request reads them: the rules ride on the roles.
  const scopeOf = async (id: string, userId = editor) => {
    const table = await findLiveTable(db, id);
    if (!table) throw new Error("no table");
    return loadRowScope(
      db,
      { userId, bindings: await loadBindings(db, userId) },
      table,
    );
  };
  const physical = async (id: string) =>
    (await findLiveTable(db, id))?.physicalName ?? "";
  const stored = async (rowId: string) => {
    const name = await physical(tableId);
    const [row] = await runStatement<{ region: string | null }>(db, {
      text: `select region from "${name}" where id = $1`,
      values: [rowId],
    });
    return row?.region;
  };
  /** The rows a table holds that are not in its trash. */
  const count = async (id: string) => {
    const name = await physical(id);
    const [row] = await runStatement<{ total: string }>(db, {
      text: `select count(*)::text as total from "${name}"`,
      values: [],
    });
    return Number(row?.total ?? 0);
  };

  beforeAll(async () => {
    const created = await createTestDatabase("row_rule_writes");
    db = created.db;
    close = created.close;
    [owner, editor] = (
      await db
        .insertInto("users")
        .values([
          { email: `owner-${suffix}@example.org`, displayName: "Owner" },
          { email: `editor-${suffix}@example.org`, displayName: "Editor" },
        ])
        .returning("id")
        .execute()
    ).map((row) => row.id) as [string, string];
    baseId = (await insertBase(db, owner, { name: "B" })).id;
    await setMemberRole(db, owner, { baseId, userId: editor, role: "editor" });
    tableId = (
      await insertTable(db, owner, {
        baseId,
        name: "Sales",
        columns: [
          { name: "title", label: "Title", fieldType: "text" },
          { name: "region", label: "Region", fieldType: "text" },
        ],
      })
    ).id;
    await narrowOn(db, owner, {
      tableId,
      userId: editor,
      rowFilter: {
        conjunction: "and",
        conditions: [{ column: "region", op: "is", value: "EU" }],
      },
      columns: [],
    });

    linkedId = (
      await insertTable(db, owner, {
        baseId,
        name: "Targets",
        columns: [{ name: "title", label: "Title", fieldType: "text" }],
      })
    ).id;
    // Made after the editor's role went table by table: given apart.
    await setTableRole(db, owner, { id: linkedId, baseId }, editor, "editor");
    [target] = await createRows(
      deps(),
      await scopeOf(linkedId, owner),
      [{ values: { title: "t" } }],
      META,
    ).then((ids) => ids as [string]);
    linkTable = (
      await insertTable(db, owner, {
        baseId,
        name: "Linked",
        columns: [{ name: "title", label: "Title", fieldType: "text" }],
      })
    ).id;
    await addRelation(db, owner, {
      tableId: linkTable,
      name: "lien",
      kind: "many_to_many",
      targetTableId: linkedId,
    });
    // A table made after the editor's role went table by table gives
    // them nothing until someone gives it (ADR 0131).
    await setTableRole(db, owner, { id: linkTable, baseId }, editor, "editor");
    await narrowOn(db, owner, {
      tableId: linkTable,
      userId: editor,
      rowFilter: {
        conjunction: "and",
        conditions: [{ column: "lien", op: "is_not_empty" }],
      },
      columns: [],
    });

    [other] = await createRows(
      deps(),
      await scopeOf(linkedId, owner),
      [{ values: { title: "other" } }],
      META,
    ).then((ids) => ids as [string]);
    dealsId = (
      await insertTable(db, owner, {
        baseId,
        name: "Deals",
        columns: [
          { name: "title", label: "Title", fieldType: "text" },
          { name: "region", label: "Region", fieldType: "text" },
        ],
      })
    ).id;
    await addRelation(db, owner, {
      tableId: dealsId,
      name: "lien",
      kind: "one_to_many",
      targetTableId: linkedId,
    });
    // A table made after the editor's role went table by table gives
    // them nothing until someone gives it (ADR 0131).
    await setTableRole(db, owner, { id: dealsId, baseId }, editor, "editor");
    await narrowOn(db, owner, {
      tableId: dealsId,
      userId: editor,
      rowFilter: {
        conjunction: "and",
        conditions: [{ column: "region", op: "is", value: "EU" }],
      },
      columns: [],
    });
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  it("creates a row inside the rule, and refuses one outside it", async () => {
    const scope = await scopeOf(tableId);
    const before = await count(tableId);
    const [inside] = await createRows(
      deps(),
      scope,
      [{ values: { title: "in", region: "EU" } }],
      META,
    );
    expect(await stored(inside ?? "")).toBe("EU");
    await expect(
      createRows(
        deps(),
        scope,
        [{ values: { title: "out", region: "US" } }],
        META,
      ),
    ).rejects.toMatchObject({ code: "row_outside_rule" });
    expect(await count(tableId)).toBe(before + 1);
  });

  it("refuses a whole batch when one of its rows is outside", async () => {
    const scope = await scopeOf(tableId);
    const before = await count(tableId);
    await expect(
      createRows(
        deps(),
        scope,
        [
          { values: { title: "a", region: "EU" } },
          { values: { title: "b", region: "US" } },
        ],
        META,
      ),
    ).rejects.toMatchObject({ code: "row_outside_rule" });
    expect(await count(tableId)).toBe(before);
  });

  it("refuses to push a row out of the rule, and keeps its value", async () => {
    const scope = await scopeOf(tableId);
    const [rowId] = await createRows(
      deps(),
      scope,
      [{ values: { title: "kept", region: "EU" } }],
      META,
    );
    await expect(
      updateRows(
        deps(),
        scope,
        [{ rowId: rowId ?? "", values: { region: "US" } }],
        META,
      ),
    ).rejects.toMatchObject({ code: "row_outside_rule" });
    expect(await stored(rowId ?? "")).toBe("EU");
    await updateRows(
      deps(),
      scope,
      [{ rowId: rowId ?? "", values: { title: "still in" } }],
      META,
    );
  });

  it("leaves someone with no rule free to write anywhere", async () => {
    const scope = await scopeOf(tableId, owner);
    const [rowId] = await createRows(
      deps(),
      scope,
      [{ values: { title: "any", region: "US" } }],
      META,
    );
    expect(await stored(rowId ?? "")).toBe("US");
  });

  it("asks a rule that reads a link once the new row has its links", async () => {
    const scope = await scopeOf(linkTable);
    const [rowId] = await createRows(
      deps(),
      scope,
      [
        {
          values: { title: "linked" },
          links: [{ column: "lien", targetIds: [target] }],
        },
      ],
      META,
    );
    expect(rowId).toBeTruthy();
  });

  it("puts a new row that ends up outside in the trash, and refuses", async () => {
    const scope = await scopeOf(linkTable);
    const before = await count(linkTable);
    await expect(
      createRows(
        deps(),
        scope,
        [
          {
            values: { title: "no link" },
            links: [{ column: "lien", targetIds: [] }],
          },
        ],
        META,
      ),
    ).rejects.toMatchObject({ code: "row_outside_rule" });
    expect(await count(linkTable)).toBe(before);
  });

  it("refuses to remove the link a rule depends on, and keeps it", async () => {
    const scope = await scopeOf(linkTable);
    const [rowId] = await createRows(
      deps(),
      scope,
      [
        {
          values: { title: "stays" },
          links: [{ column: "lien", targetIds: [target] }],
        },
      ],
      META,
    );
    await expect(
      replaceLinks(
        deps(),
        scope,
        rowId ?? "",
        { column: "lien", targetIds: [] },
        META,
      ),
    ).rejects.toMatchObject({ code: "row_outside_rule" });
    await expect(
      replaceLinks(
        deps(),
        scope,
        rowId ?? "",
        { column: "lien", targetIds: [target] },
        META,
      ),
    ).resolves.toBeUndefined();
  });

  describe("a new row whose link cannot be written", () => {
    const create = async (region: string, targetIds: string[]) =>
      createRows(
        deps(),
        await scopeOf(dealsId),
        [
          {
            values: { title: "deal", region },
            links: [{ column: "lien", targetIds }],
          },
        ],
        META,
      );

    it("leaves nothing behind for a target that does not exist", async () => {
      const before = await count(dealsId);
      await expect(
        create("US", ["00000000-0000-4000-8000-000000000000"]),
      ).rejects.toBeDefined();
      expect(await count(dealsId)).toBe(before);
    });

    it("leaves nothing behind for two targets on a single link", async () => {
      const before = await count(dealsId);
      await expect(create("US", [target, other])).rejects.toMatchObject({
        code: "invalid_link_count",
      });
      expect(await count(dealsId)).toBe(before);
    });

    it("leaves nothing behind for a row inside the rule either", async () => {
      const before = await count(dealsId);
      await expect(create("EU", [target, other])).rejects.toMatchObject({
        code: "invalid_link_count",
      });
      expect(await count(dealsId)).toBe(before);
    });

    it("still creates a row inside the rule with its link", async () => {
      const [rowId] = await create("EU", [target]);
      expect(rowId).toBeTruthy();
    });
  });

  describe("an import by someone under a row rule", () => {
    const importFile = async (
      rows: ReadonlyArray<readonly string[]>,
      upsertSource?: number,
    ) => {
      const scope = await scopeOf(tableId);
      return importIntoTable(db, {
        userId: editor,
        table: scope.table,
        source: rowsSource(["title", "region"], rows),
        mapping: [
          { source: 0, column: "title" },
          { source: 1, column: "region" },
        ],
        upsertSource,
        addOptions: false,
        canManage: false,
        eventKey: `test:${randomBytes(4).toString("hex")}`,
        rowScope: scope.engine,
      });
    };
    const titled = async (title: string) => {
      const name = await physical(tableId);
      return runStatement<{ id: string; region: string | null }>(db, {
        text: `select id, region from "${name}" where title = $1`,
        values: [title],
      });
    };

    it("refuses a line outside the rule and writes the others", async () => {
      const before = await count(tableId);
      const result = await importFile([
        ["import in", "EU"],
        ["import out", "US"],
        ["import in too", "EU"],
      ]);
      expect(result).toMatchObject({ inserted: 2, updated: 0, failed: 1 });
      expect(result.errors).toEqual([
        expect.objectContaining({ line: 3, code: "row_outside_rule" }),
      ]);
      expect(await count(tableId)).toBe(before + 2);
      expect(await titled("import out")).toEqual([]);
    });

    it("updates a key inside the rule, and refuses one outside", async () => {
      await createRows(
        deps(),
        await scopeOf(tableId, owner),
        [
          { values: { title: "key in", region: "EU" } },
          { values: { title: "key out", region: "US" } },
        ],
        META,
      );
      const result = await importFile(
        [
          ["key in", "EU"],
          ["key out", "EU"],
        ],
        0,
      );
      expect(result).toMatchObject({ inserted: 0, updated: 1, failed: 1 });
      expect(result.errors).toEqual([
        expect.objectContaining({ line: 3, code: "access_denied" }),
      ]);
      expect((await titled("key out"))[0]?.region).toBe("US");
    });

    it("refuses a key whose line would push its row out", async () => {
      await createRows(
        deps(),
        await scopeOf(tableId),
        [{ values: { title: "key moved", region: "EU" } }],
        META,
      );
      const result = await importFile([["key moved", "US"]], 0);
      expect(result).toMatchObject({ inserted: 0, updated: 0, failed: 1 });
      expect(result.errors).toEqual([
        expect.objectContaining({ line: 2, code: "row_outside_rule" }),
      ]);
      expect((await titled("key moved"))[0]?.region).toBe("EU");
    });
  });
});
