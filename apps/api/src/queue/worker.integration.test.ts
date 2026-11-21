/**
 * The queue's schema, installed in a database that holds nothing: a new
 * install's first start. PostgreSQL writes every statement it refuses in
 * its log as an error, and an operator reads that log.
 */
import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { migrateQueue } from "./worker.js";

describe("the queue's schema in a new database", () => {
  const adminUrl = inject("adminUrl");
  const made: string[] = [];
  let admin: pg.Client;
  const quiet = {
    error: () => undefined,
    warn: () => undefined,
    info: () => undefined,
    debug: () => undefined,
  };

  /** A database with nothing in it. */
  const empty = async (): Promise<{ name: string; url: string }> => {
    const name = `queue_${randomBytes(6).toString("hex")}`;
    await admin.query(`create database "${name}"`);
    made.push(name);
    const url = new URL(adminUrl);
    url.pathname = `/${name}`;
    return { name, url: url.toString() };
  };

  /**
   * Transactions the database rolled back: a refused statement is one. A
   * session writes its figures as it leaves, before it is off the list of
   * sessions: the count is read once nobody is left in the database.
   */
  const refused = async (name: string): Promise<number> => {
    await expect
      .poll(
        async () => {
          const { rows } = await admin.query<{ open: string }>(
            "select count(*)::text as open from pg_stat_activity where datname = $1 and backend_type = 'client backend'",
            [name],
          );
          return rows[0]?.open;
        },
        { timeout: 10_000 },
      )
      .toBe("0");
    const { rows } = await admin.query<{ rolled: string }>(
      "select xact_rollback::text as rolled from pg_stat_database where datname = $1",
      [name],
    );
    return Number(rows[0]?.rolled ?? 0);
  };

  /** What the library installed: its migrations, and its tables. */
  const installed = async (
    url: string,
  ): Promise<{ migrations: number; tables: string[] }> => {
    const reader = new pg.Client({ connectionString: url });
    await reader.connect();
    try {
      const migrations = await reader.query<{ applied: string }>(
        "select count(*)::text as applied from graphile_worker.migrations",
      );
      const tables = await reader.query<{ name: string }>(
        "select table_name as name from information_schema.tables where table_schema = 'graphile_worker' order by table_name",
      );
      return {
        migrations: Number(migrations.rows[0]?.applied ?? 0),
        tables: tables.rows.map((table) => table.name),
      };
    } finally {
      await reader.end();
    }
  };

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
  }, 60_000);

  afterAll(async () => {
    for (const name of made) {
      await admin.query(`drop database if exists "${name}" with (force)`);
    }
    await admin.end();
  });

  it("is installed without a statement the database refuses, and left alone afterwards", async () => {
    const { name, url } = await empty();
    const before = await refused(name);
    await migrateQueue(url, quiet);
    expect(await refused(name)).toBe(before);

    const first = await installed(url);
    expect(first.migrations).toBeGreaterThan(0);
    expect(first.tables).toContain("_private_jobs");

    // A start on a database that has the schema changes nothing of it.
    await migrateQueue(url, quiet);
    expect(await installed(url)).toEqual(first);
    expect(await refused(name)).toBe(before);
  }, 60_000);

  it("is installed whole by two instances that start at once", async () => {
    const alone = await empty();
    await migrateQueue(alone.url, quiet);

    const shared = await empty();
    await Promise.all([
      migrateQueue(shared.url, quiet),
      migrateQueue(shared.url, quiet),
    ]);
    expect(await installed(shared.url)).toEqual(await installed(alone.url));
  }, 60_000);
});
