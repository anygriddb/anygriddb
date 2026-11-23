import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { databaseRoleIsSuperuser, databaseRoleOwnsTables } from "./admin.js";
import { createTestDatabase } from "./test-database.js";

describe("the role the instance signs in as", () => {
  let db: Database;
  let ownerDb: Database;
  let close: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const created = await createTestDatabase("role");
    db = created.db;
    ownerDb = created.owner.db;
    close = created.close;
  });

  afterAll(async () => {
    await close?.();
  });

  it("says when it is a superuser", async () => {
    expect(await databaseRoleIsSuperuser(ownerDb)).toBe(true);
  });

  it("says when it is not", async () => {
    expect(await databaseRoleIsSuperuser(db)).toBe(false);
  });

  it("says whether it owns the tables", async () => {
    expect(await databaseRoleOwnsTables(ownerDb)).toBe(true);
    expect(await databaseRoleOwnsTables(db)).toBe(false);
  });
});
