/**
 * A row rule holds for what a row becomes, as for what it was, on a
 * migrated database: a writer neither creates a row outside it nor pushes
 * one out, and a refused write leaves nothing behind (ADR 0112).
 */
import { randomBytes } from "node:crypto";
import type { Binding } from "@anygriddb/core";
import { runStatement, type Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setTableAcl } from "../data/acl.js";
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

  const deps = () => ({ db, bus, log: () => undefined });
  const bindings = (): Binding[] => [
    { role: "editor", scope: "base", scopeId: baseId },
  ];
  const scopeOf = async (id: string, userId = editor) => {
    const table = await findLiveTable(db, id);
    if (!table) throw new Error("no table");
    return loadRowScope(
      db,
      {
        userId,
        bindings:
          userId === owner
            ? [{ role: "owner", scope: "base", scopeId: baseId }]
            : bindings(),
      },
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
    await setTableAcl(db, owner, {
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
    await setTableAcl(db, owner, {
      tableId: linkTable,
      userId: editor,
      rowFilter: {
        conjunction: "and",
        conditions: [{ column: "lien", op: "is_not_empty" }],
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
});
