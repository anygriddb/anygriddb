/**
 * What the home page says of the tables a person opened: the rows they
 * see and the last change, for the tables they can read and no other.
 */
import { randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recordExport } from "../data/export-audit.js";
import { keyRing } from "../auth/key-ring.js";
import type { Env } from "../env.js";
import { createTestDatabase } from "../test-database.js";
import {
  browserFactory,
  enrollTotp,
  signUpProved,
} from "./caller.test-helpers.js";

const suffix = randomBytes(6).toString("hex");
const PASSWORD = "correct horse battery staple";

describe("catalog.activity", () => {
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
  const browser = browserFactory({ db: () => db, env, hub });
  const owner = browser();
  const stranger = browser();
  let tableId = "";

  beforeAll(async () => {
    const created = await createTestDatabase("catalog-activity");
    db = created.db;
    close = created.close;
    await owner.call().auth.signup({
      email: `owner-${suffix}@example.org`,
      displayName: "Olive Owner",
      password: PASSWORD,
    });
    await enrollTotp(owner);
    const baseId = (await owner.call().catalog.createBase({ name: "Lab" })).id;
    tableId = (
      await owner.call().catalog.createTable({
        baseId,
        name: "Samples",
        columns: [{ name: "ref", label: "Ref", fieldType: "text" }],
      })
    ).id;
    await owner.call().rows.insertMany({
      tableId,
      rows: [{ ref: "A-1" }, { ref: "A-2" }],
    });
    await signUpProved(stranger, db, {
      email: `stranger-${suffix}@example.org`,
      displayName: "Sam Stranger",
      password: PASSWORD,
    });
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  it("tells the rows of a table its reader sees, and who changed it last", async () => {
    const [activity] = await owner.call().catalog.activity({
      tableIds: [tableId],
    });
    expect(activity?.tableId).toBe(tableId);
    // A new table starts with rows of its own: the count is theirs too.
    expect(activity?.rows?.estimated).toBe(false);
    expect(activity?.rows?.total).toBeGreaterThanOrEqual(2);
    expect(activity?.changed?.by.name).toBe("Olive Owner");
    expect(Date.now() - Date.parse(activity?.changed?.at ?? "")).toBeLessThan(
      60_000,
    );
  });

  it("does not take an export for a change", async () => {
    const before = await owner.call().catalog.activity({ tableIds: [tableId] });
    // Someone else takes the table's rows out, later.
    const other = await db
      .insertInto("users")
      .values({ email: `export-${suffix}@example.org`, displayName: "Eve" })
      .returning("id")
      .executeTakeFirstOrThrow();
    await recordExport(db, {
      userId: other.id,
      tableId,
      source: "web",
      export: { kind: "view", format: "csv", rows: 2 },
    });
    const after = await owner.call().catalog.activity({ tableIds: [tableId] });
    expect(after[0]?.changed).toEqual(before[0]?.changed);
    expect(after[0]?.changed?.by.name).toBe("Olive Owner");
  });

  it("says nothing of a table the caller cannot read, or that does not exist", async () => {
    expect(
      await stranger.call().catalog.activity({ tableIds: [tableId] }),
    ).toEqual([]);
    expect(
      await owner.call().catalog.activity({
        tableIds: ["00000000-0000-4000-8000-000000000001"],
      }),
    ).toEqual([]);
  });
});
