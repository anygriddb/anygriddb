import type { Database } from "@anygriddb/db";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { databaseRoleIsSuperuser } from "./admin.js";
import { createTestDatabase } from "./test-database.js";

describe("the role the instance signs in as", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const created = await createTestDatabase("role");
    db = created.db;
    close = created.close;
  });

  afterAll(async () => {
    await close?.();
  });

  it("says when it is a superuser", async () => {
    expect(await databaseRoleIsSuperuser(db)).toBe(true);
  });

  it("says when it is not", async () => {
    await sql`create role grid_limited nologin`.execute(db);
    await db.transaction().execute(async (tx) => {
      await sql`set local role grid_limited`.execute(tx);
      expect(await databaseRoleIsSuperuser(tx)).toBe(false);
    });
  });
});
