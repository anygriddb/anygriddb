import { grantRuntimeRole } from "@anygriddb/db";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertPrepared,
  DatabaseNotPrepared,
  signsInAsOwner,
} from "./database-start.js";
import { createTestDatabase } from "./test-database.js";

describe("what a process checks of its database at the start", () => {
  let application: pg.Pool;
  let owner: pg.Pool;
  let close: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const created = await createTestDatabase("database_start");
    application = created.pool;
    owner = created.owner.pool;
    close = created.close;
  });

  afterAll(async () => {
    await close?.();
  });

  it("tells the owner from the role that owns nothing", async () => {
    expect(await signsInAsOwner(owner)).toBe(true);
    expect(await signsInAsOwner(application)).toBe(false);
  });

  it("takes a database at this version", async () => {
    await expect(assertPrepared(application)).resolves.toBeUndefined();
  });

  it("refuses one a migration behind, and says what to run", async () => {
    const { rows } = await owner.query<{ name: string; checksum: string }>(
      "delete from schema_migrations where name = (select max(name) from schema_migrations) returning name, checksum",
    );
    try {
      await expect(assertPrepared(application)).rejects.toThrow(
        DatabaseNotPrepared,
      );
      await expect(assertPrepared(application)).rejects.toThrow(
        /anygriddb database prepare/,
      );
    } finally {
      await owner.query(
        "insert into schema_migrations (name, checksum) values ($1, $2)",
        [rows[0]?.name, rows[0]?.checksum],
      );
    }
  });

  it("gives no application rights to a role that owns the tables", async () => {
    const { rows } = await owner.query<{ me: string }>(
      "select current_user as me",
    );
    await expect(grantRuntimeRole(owner, rows[0]?.me ?? "")).rejects.toThrow(
      /owns the tables/,
    );
  });
});
