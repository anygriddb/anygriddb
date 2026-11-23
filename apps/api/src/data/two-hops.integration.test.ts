/**
 * A lookup of a lookup and a rollup of a rollup, against a real database:
 * tables A, B, C, each linked to the next. A read of A follows both links,
 * and a reader's rules on C hold two links away as they do one.
 */
import { randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadBindings } from "../auth/access.js";
import { createTestDatabase } from "../test-database.js";
import { clearTableAcl, readerEngine, setTableAcl } from "./acl.js";
import { withAudit } from "./audit-context.js";
import { insertComputed } from "./computed.js";
import { loadEngine } from "./engine.js";
import { addRelation, setLinks } from "./relations.js";
import { insertRows, readPage, type WriteContext } from "./rows.js";
import { insertBase, insertTable } from "./schema-ops.js";

const suffix = randomBytes(6).toString("hex");

describe("a field read across two links", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let owner = "";
  let reader = "";
  let baseId = "";
  const tables: Record<"a" | "b" | "c", string> = { a: "", b: "", c: "" };

  async function context(tableId: string): Promise<WriteContext> {
    const row = await db
      .selectFrom("dataTables")
      .selectAll()
      .where("id", "=", tableId)
      .executeTakeFirstOrThrow();
    return {
      userId: owner,
      tableId,
      physicalName: row.physicalName,
      baseId,
      reason: null,
      source: "web",
    };
  }

  const ownerEngine = async (tableId: string) =>
    (await loadEngine(db, tableId, () => true)).engine;

  async function link(
    tableId: string,
    column: string,
    rowId: string,
    to: string,
  ) {
    const engine = await ownerEngine(tableId);
    const target = engine.table.columns.find((item) => item.name === column);
    if (!target) throw new Error(`no column ${column}`);
    await setLinks(db, engine, {
      userId: owner,
      tableId,
      physicalName: (await context(tableId)).physicalName,
      column: target,
      rowId,
      targetIds: [to],
      reason: null,
    });
  }

  /** The one row of A, as the owner or as the reader under their rules. */
  async function rowOfA(as: "owner" | "reader") {
    const engine =
      as === "owner"
        ? await ownerEngine(tables.a)
        : (
            await readerEngine(db, tables.a, {
              userId: reader,
              bindings: await loadBindings(db, reader),
            })
          ).engine;
    const page = await readPage(db, engine, { limit: 5 }, { total: false });
    const [row]: Array<Record<string, unknown>> = page.rows;
    return row ?? {};
  }

  beforeAll(async () => {
    const created = await createTestDatabase("two_hops");
    db = created.db;
    close = created.close;
    const people = await db
      .insertInto("users")
      .values([
        { email: `owner-${suffix}@example.com`, displayName: "Owner" },
        { email: `reader-${suffix}@example.com`, displayName: "Reader" },
      ])
      .returning("id")
      .execute();
    owner = people[0]?.id ?? "";
    reader = people[1]?.id ?? "";
    baseId = (await insertBase(db, owner, { name: `Hops ${suffix}` })).id;
    await withAudit(db, { userId: owner, source: "web" }, (tx) =>
      tx
        .insertInto("roleBindings")
        .values({
          userId: reader,
          role: "editor",
          scope: "base",
          scopeId: baseId,
        })
        .execute(),
    );
    for (const [key, name, columns] of [
      ["a", "A", [{ name: "label", label: "Label", fieldType: "text" }]],
      ["b", "B", [{ name: "label", label: "Label", fieldType: "text" }]],
      [
        "c",
        "C",
        [
          { name: "label", label: "Label", fieldType: "text" },
          { name: "n", label: "N", fieldType: "number" },
        ],
      ],
    ] as const) {
      tables[key] = (
        await insertTable(db, owner, { baseId, name, columns: [...columns] })
      ).id;
    }
    await addRelation(db, owner, {
      tableId: tables.a,
      name: "to_b",
      label: "To B",
      kind: "many_to_many",
      targetTableId: tables.b,
    });
    await addRelation(db, owner, {
      tableId: tables.b,
      name: "to_c",
      label: "To C",
      kind: "many_to_many",
      targetTableId: tables.c,
    });
    const always = () => true;
    const computed = [
      [tables.b, "sum_n", "to_c", "n", "sum"],
      [tables.b, "seen_n", "to_c", "n", undefined],
      [tables.a, "sum_sum", "to_b", "sum_n", "sum"],
      [tables.a, "seen_seen", "to_b", "seen_n", undefined],
    ] as const;
    for (const [tableId, name, relation, target, fn] of computed) {
      await insertComputed(
        db,
        owner,
        { tableId, name, label: name, relation, target, fn },
        always,
      );
    }
    const [c = ""] = await insertRows(
      db,
      await ownerEngine(tables.c),
      await context(tables.c),
      [{ label: "c", n: "7" }],
    );
    const [b = ""] = await insertRows(
      db,
      await ownerEngine(tables.b),
      await context(tables.b),
      [{ label: "b" }],
    );
    const [a = ""] = await insertRows(
      db,
      await ownerEngine(tables.a),
      await context(tables.a),
      [{ label: "a" }],
    );
    await link(tables.b, "to_c", b, c);
    await link(tables.a, "to_b", a, b);
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  it("computes from A what B computes from C", async () => {
    // The read of A loaded B and stopped: C was missing, the rollup was 0
    // and the lookup empty, with nothing to say so.
    const row = await rowOfA("owner");
    expect(row.sum_sum).toBe("7");
    expect(row.seen_seen).toEqual(["7"]);
    expect(await rowOfA("reader")).toMatchObject({
      sum_sum: "7",
      seen_seen: ["7"],
    });
  });

  it("holds a reader's rules on the table two links away", async () => {
    // A field of C hidden from the reader stays hidden through both links.
    await setTableAcl(db, owner, {
      tableId: tables.c,
      userId: reader,
      rowFilter: null,
      columns: [{ column: "n", access: "hide" }],
    });
    const hidden = await rowOfA("reader");
    expect(JSON.stringify(hidden.seen_seen ?? [])).not.toContain("7");
    expect(hidden.sum_sum ?? null).not.toBe("7");
    // A row of C outside the reader's rule is not theirs to add up.
    await setTableAcl(db, owner, {
      tableId: tables.c,
      userId: reader,
      rowFilter: {
        conjunction: "and",
        conditions: [{ column: "label", op: "is", value: "another" }],
      },
      columns: [],
    });
    const outside = await rowOfA("reader");
    expect(JSON.stringify(outside.seen_seen ?? [])).not.toContain("7");
    expect(outside.sum_sum ?? null).not.toBe("7");
    await clearTableAcl(db, owner, tables.c, reader);
    expect(await rowOfA("reader")).toMatchObject({ sum_sum: "7" });
    // The owner read all of it throughout.
    expect(await rowOfA("owner")).toMatchObject({ sum_sum: "7" });
  });
});
