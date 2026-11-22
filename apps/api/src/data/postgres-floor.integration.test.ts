/**
 * The floor on real servers: the one below it is refused with nothing
 * written, and every migration runs on the first one it accepts.
 */
import {
  createDb,
  migrateDb,
  migrationNames,
  PostgresTooOld,
} from "@anygriddb/db";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { sql } from "kysely";
import { describe, expect, it } from "vitest";

async function onServer(
  image: string,
  check: (db: ReturnType<typeof createDb>) => Promise<void>,
) {
  const server = await new PostgreSqlContainer(image).start();
  const created = createDb(server.getConnectionUri());
  try {
    await check(created);
  } finally {
    await created.close();
    await server.stop();
  }
}

describe("the PostgreSQL floor", () => {
  it("refuses PostgreSQL 15 and leaves its database empty", async () => {
    await onServer("postgres:15", async ({ db, pool }) => {
      await expect(migrateDb(pool)).rejects.toBeInstanceOf(PostgresTooOld);
      const tables = await sql<{ count: number }>`
        select count(*)::int as count from information_schema.tables
        where table_schema = 'public'
      `.execute(db);
      expect(tables.rows[0]?.count).toBe(0);
    });
  }, 180_000);

  it("runs every migration on PostgreSQL 16", async () => {
    await onServer("postgres:16", async ({ pool }) => {
      expect(await migrateDb(pool)).toEqual(await migrationNames());
    });
  }, 180_000);
});
