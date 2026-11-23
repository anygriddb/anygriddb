/**
 * The trash and the comments of a table list rows and comments, not a
 * window of what happened to them, against a real database.
 */
import { randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keyRing } from "../auth/key-ring.js";
import type { Env } from "../env.js";
import { createTestDatabase } from "../test-database.js";
import {
  browserFactory,
  enrollTotp,
  errorCode as code,
} from "./caller.test-helpers.js";

const suffix = randomBytes(6).toString("hex");

describe("lists that read rows, not a window of events", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  const env = {
    AUTH_ENCRYPTION_KEY: keyRing(randomBytes(32)),
    PUBLIC_URL: "https://grid.example.org",
  } as unknown as Env;
  const hub = {
    closeUser: () => 0,
    closeAllBut: () => 0,
    closeSession: () => 0,
  };
  const owner = browserFactory({ db: () => db, env, hub })();
  let baseId = "";

  /** A table of its own, with rows named as given, and their ids. */
  async function table(names: readonly string[]) {
    const tableId = (
      await owner.call().catalog.createTable({
        baseId,
        name: `Rows ${randomBytes(3).toString("hex")}`,
        columns: [{ name: "title", label: "Title", fieldType: "text" }],
      })
    ).id;
    const ids: string[] = [];
    for (const title of names) {
      ids.push(
        (await owner.call().rows.insert({ tableId, values: { title } })).id,
      );
    }
    return { tableId, ids };
  }

  /** Deletes a row and puts it back, as many times as said. */
  async function restless(tableId: string, rowId: string, times: number) {
    for (let turn = 0; turn < times; turn += 1) {
      await owner.call().rows.deleteMany({ tableId, rowIds: [rowId] });
      await owner.call().rows.restore({ tableId, rowIds: [rowId] });
    }
  }

  beforeAll(async () => {
    const created = await createTestDatabase("rows_lists");
    db = created.db;
    close = created.close;
    await owner.signUpFirst({
      email: `owner-${suffix}@example.org`,
      displayName: "Olive Owner",
      password: "correct horse battery staple",
    });
    await enrollTotp(owner);
    baseId = (await owner.call().catalog.createBase({ name: "Ledger" })).id;
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  it("lists the rows of the trash whatever one restless row did", async () => {
    const names = Array.from(
      { length: 13 },
      (_, index) => `Row ${String(index)}`,
    );
    const { tableId, ids } = await table(names);
    const [churned = "", ...others] = ids;
    await owner.call().rows.deleteMany({ tableId, rowIds: others });
    // Deleted and put back many times, then deleted: its events alone
    // filled the window the trash read, and no other row was listed.
    await restless(tableId, churned, 45);
    await owner.call().rows.deleteMany({ tableId, rowIds: [churned] });
    const page = await owner.call().rows.trash({ tableId, limit: 10 });
    expect(page.rows).toHaveLength(10);
    expect(new Set(page.rows.map((row) => row.rowId)).size).toBe(10);
    // Newest first: the restless row was deleted last.
    expect(page.rows[0]?.rowId).toBe(churned);
    const whole = await owner.call().rows.trash({ tableId, limit: 50 });
    expect(whole.rows.map((row) => row.rowId).sort()).toEqual([...ids].sort());
  }, 120_000);

  it("lists no row that was put back", async () => {
    const { tableId, ids } = await table(["Kept", "Gone"]);
    const [kept = "", gone = ""] = ids;
    await restless(tableId, kept, 3);
    await owner.call().rows.deleteMany({ tableId, rowIds: [gone] });
    const page = await owner.call().rows.trash({ tableId, limit: 10 });
    expect(page.rows.map((row) => row.rowId)).toEqual([gone]);
  });

  it("restores several rows at once, one of them deleted and put back since", async () => {
    const { tableId, ids } = await table(["Still", "Restless"]);
    const [still = "", moved = ""] = ids;
    await owner.call().rows.deleteMany({ tableId, rowIds: [still] });
    await restless(tableId, moved, 10);
    await owner.call().rows.deleteMany({ tableId, rowIds: [moved] });
    // Each came back alone; the two together were refused as unknown.
    expect(
      await code(
        owner.call().rows.restore({ tableId, rowIds: [still, moved] }),
      ),
    ).toBe("ok");
    const read = await owner.call().rows.read({ tableId });
    expect(read.rows.map((row) => row.id).sort()).toEqual([...ids].sort());
    // A row that was never deleted is still refused, with the others.
    expect(
      await code(owner.call().rows.restore({ tableId, rowIds: [still] })),
    ).toBe("unknown_row");
  }, 120_000);

  it("lists the latest comments of a row that has more than are listed", async () => {
    const { tableId, ids } = await table(["Much discussed"]);
    const [rowId = ""] = ids;
    for (let number = 1; number <= 520; number += 1) {
      await owner
        .call()
        .rows.addComment({ tableId, rowId, body: `Comment ${String(number)}` });
    }
    const listed = await owner.call().rows.comments({ tableId, rowId });
    const bodies = listed.comments.map((comment) => comment.body);
    expect(bodies).toHaveLength(500);
    // Oldest first, as before, and the twenty just written among them.
    expect(bodies[0]).toBe("Comment 21");
    expect(bodies.at(-1)).toBe("Comment 520");
  }, 240_000);
});
