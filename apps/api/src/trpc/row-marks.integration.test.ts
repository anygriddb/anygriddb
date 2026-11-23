/**
 * A row's own marks and its fields live under different names: a field
 * called `signature` or `drift` keeps its value beside the row's signature.
 */
import { randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keyRing } from "../auth/key-ring.js";
import type { Env } from "../env.js";
import { createTestDatabase } from "../test-database.js";
import { browserFactory, enrollTotp } from "./caller.test-helpers.js";

const suffix = randomBytes(6).toString("hex");
const PASSWORD = "correct horse battery staple";

describe("a row's marks beside its fields", () => {
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
  let tableId = "";
  let rowId = "";

  beforeAll(async () => {
    const created = await createTestDatabase("row-marks");
    db = created.db;
    close = created.close;
    await owner.signUpFirst({
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
        columns: [
          { name: "signature", label: "Signature", fieldType: "text" },
          { name: "drift", label: "Drift", fieldType: "text" },
        ],
      })
    ).id;
    [rowId = ""] = (
      await owner.call().rows.insertMany({
        tableId,
        rows: [{ signature: "Ada", drift: "north" }],
      })
    ).ids;
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  it("reads a field named signature or drift, unsigned and signed", async () => {
    const before = await owner.call().rows.read({ tableId, limit: 10 });
    expect(before.rows[0]).toMatchObject({
      signature: "Ada",
      drift: "north",
      ag_signature: null,
      ag_drift: null,
    });
    await owner.call().rows.setStatus({ tableId, rowId, status: "submitted" });
    await owner.call().rows.setStatus({ tableId, rowId, status: "locked" });
    await owner
      .call()
      .rows.sign({ tableId, rowId, meaning: "Approved", password: PASSWORD });
    const after = await owner.call().rows.read({ tableId, limit: 10 });
    expect(after.rows[0]?.signature).toBe("Ada");
    expect(after.rows[0]?.drift).toBe("north");
    expect(after.rows[0]?.ag_signature?.meaning).toBe("Approved");
  });

  it("gives no field the name of a mark", async () => {
    const added = await owner.call().catalog.addColumn({
      tableId,
      label: "ag_signature",
      fieldType: "text",
    });
    expect(added.name).not.toBe("ag_signature");
  });
});
