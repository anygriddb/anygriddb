import { randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase } from "../test-database.js";
import { insertBase, insertTable } from "./schema-ops.js";
import { listShortcuts, setPin, touchTable } from "./shortcuts.js";

const suffix = randomBytes(6).toString("hex");

describe("pins and recent tables", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let owner = "";
  let other = "";
  let baseId = "";
  const tables: string[] = [];

  beforeAll(async () => {
    const created = await createTestDatabase("shortcuts");
    db = created.db;
    close = created.close;
    const people = await db
      .insertInto("users")
      .values([
        { email: `pins-${suffix}@example.com`, displayName: "Pins" },
        { email: `other-${suffix}@example.com`, displayName: "Other" },
      ])
      .returning("id")
      .execute();
    owner = people[0]?.id ?? "";
    other = people[1]?.id ?? "";
    baseId = (await insertBase(db, owner, { name: "Shortcuts" })).id;
    for (const name of ["Alpha", "Beta", "Gamma"]) {
      const table = await insertTable(db, owner, {
        baseId,
        name,
        columns: [{ name: "name", label: "Name", fieldType: "text" }],
      });
      tables.push(table.id);
    }
  });

  afterAll(async () => {
    await close?.();
  });

  it("pins once, unpins, and keeps each person's own", async () => {
    const [alpha = "", beta = ""] = tables;
    await setPin(db, owner, { baseId }, true);
    await setPin(db, owner, { tableId: alpha }, true);
    // Pinning twice is not an error, and lists it once.
    await setPin(db, owner, { tableId: alpha }, true);
    await setPin(db, owner, { tableId: beta }, true);
    await setPin(db, owner, { tableId: beta }, false);
    const mine = await listShortcuts(db, owner);
    expect(mine.pinnedBases).toEqual([baseId]);
    expect(mine.pinnedTables).toEqual([alpha]);
    const theirs = await listShortcuts(db, other);
    expect(theirs.pinnedBases).toEqual([]);
    expect(theirs.pinnedTables).toEqual([]);
  });

  it("lists opened tables, last first, once each", async () => {
    const [alpha = "", beta = "", gamma = ""] = tables;
    await touchTable(db, owner, alpha);
    await touchTable(db, owner, beta);
    await touchTable(db, owner, gamma);
    await touchTable(db, owner, alpha);
    const { recentTables } = await listShortcuts(db, owner);
    expect(recentTables.map((recent) => recent.tableId)).toEqual([
      alpha,
      gamma,
      beta,
    ]);
    expect((await listShortcuts(db, other)).recentTables).toEqual([]);
  });

  it("refuses a pin naming both a base and a table", async () => {
    await expect(
      db
        .insertInto("pins")
        .values({ userId: owner, baseId, tableId: tables[0] ?? "" })
        .execute(),
    ).rejects.toThrow();
  });
});
