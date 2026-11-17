/**
 * Applies the plain SQL migrations in `migrations/` (ADR 0004). The SQL is
 * the only source of truth: no schema is diffed from TypeScript.
 *
 * - Files run in name order, each in one transaction.
 * - An advisory lock keeps two starting instances from migrating at once.
 * - Each applied file is recorded with its SHA-256; a file that changed
 *   after it was applied stops the start, and so does a database that
 *   knows a migration this code does not.
 * - A migration that may refuse a database says so in a file beside it,
 *   `NNNN_name.check.sql`, asked of every pending migration before the
 *   first of them runs: an upgrade that is refused changes nothing, and
 *   the version before starts again on the same data (ADR 0106).
 * - A database Drizzle migrated is adopted: its applied files are recorded
 *   without running them again.
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type pg from "pg";

/**
 * Set by the API's production build, which copies the migrations next to
 * the bundle. From sources (tsx, Vitest) the constant does not exist.
 */
declare const __ANYGRID_MIGRATIONS__: string | undefined;

const LOCK = "anygriddb.migrations";
const FILE = /^\d{4}_[a-z0-9_]+\.sql$/;
const CHECK = ".check.sql";

/**
 * When Drizzle recorded each file it applied (its journal's `when`), for
 * the files that existed under Drizzle. Adoption matches by checksum
 * first, and falls back on this for a file edited since.
 */
const DRIZZLE_WHEN: Readonly<Record<string, number>> = {
  "0000_identity_catalog": 1794001140131,
  "0001_webauthn": 1794003954331,
  "0002_relation_constraints": 1794005872996,
  "0003_audit_trail": 1794007681248,
  "0004_product_views": 1794010491296,
  "0005_catalog_v2": 1794016712635,
  "0006_attachments": 1794019635497,
  "0007_sharing": 1794019893351,
  "0008_token_scopes": 1794020280035,
  "0009_webhooks_v2": 1794022072703,
  "0010_notifications": 1794022682073,
  "0011_automations": 1794023114697,
  "0012_admin": 1794024042177,
  "0013_jobs": 1794038701475,
  "0014_trash": 1794039585513,
  "0015_snapshots": 1794048000000,
  "0016_dashboards": 1794050000000,
  "0017_acl": 1794052000000,
  "0018_acl_audit": 1794054000000,
  "0019_row_events": 1794056000000,
};

function migrationsFolder(): string {
  const bundled =
    typeof __ANYGRID_MIGRATIONS__ === "string"
      ? __ANYGRID_MIGRATIONS__
      : undefined;
  return fileURLToPath(new URL(bundled ?? "../migrations", import.meta.url));
}

type Migration = {
  name: string;
  sql: string;
  checksum: string;
  /** What it asks of the database before any pending migration runs. */
  check: string | null;
};

async function readMigrations(folder: string): Promise<Migration[]> {
  const present = await readdir(folder);
  const files = present.filter((name) => FILE.test(name));
  files.sort();
  return Promise.all(
    files.map(async (file) => {
      const name = file.slice(0, -".sql".length);
      const sql = await readFile(`${folder}/${file}`, "utf8");
      return {
        name,
        sql,
        checksum: createHash("sha256").update(sql).digest("hex"),
        check: present.includes(`${name}${CHECK}`)
          ? await readFile(`${folder}/${name}${CHECK}`, "utf8")
          : null,
      };
    }),
  );
}

/**
 * An upgrade a pending migration's check refused, before any of them
 * ran. Its message ends with what the check raised: what to do first,
 * with the version before.
 */
export class UpgradeRefused extends Error {
  constructor(
    readonly migration: string,
    cause: unknown,
  ) {
    const reason = cause instanceof Error ? cause.message : "its check failed";
    super(
      `Upgrade refused by ${migration}, before anything was changed: ${reason}`,
      { cause },
    );
    this.name = "UpgradeRefused";
  }
}

/**
 * Asks the check of each pending migration that has one, in a
 * transaction that may only read. A check refuses by raising.
 */
async function askChecks(
  client: pg.PoolClient,
  pending: readonly Migration[],
): Promise<void> {
  for (const migration of pending) {
    if (migration.check === null) continue;
    await client.query("begin transaction read only");
    try {
      await client.query(migration.check);
    } catch (error) {
      throw new UpgradeRefused(migration.name, error);
    } finally {
      await client.query("rollback");
    }
  }
}

/** Records the files a Drizzle-migrated database already ran. */
async function adoptDrizzle(
  client: pg.PoolClient,
  migrations: readonly Migration[],
): Promise<void> {
  const exists = await client.query<{ found: string | null }>(
    `select to_regclass('drizzle.__drizzle_migrations')::text as found`,
  );
  if (!exists.rows[0]?.found) return;
  const recorded = await client.query<{ count: number }>(
    `select count(*)::int as count from schema_migrations`,
  );
  if ((recorded.rows[0]?.count ?? 0) > 0) return;
  const applied = await client.query<{ hash: string; created_at: string }>(
    `select hash, created_at::text from drizzle.__drizzle_migrations`,
  );
  const hashes = new Set(applied.rows.map((row) => row.hash));
  const times = new Set(applied.rows.map((row) => Number(row.created_at)));
  const adopted = migrations.filter(
    (migration) =>
      hashes.has(migration.checksum) ||
      times.has(DRIZZLE_WHEN[migration.name] ?? -1),
  );
  if (adopted.length !== applied.rows.length) {
    throw new Error(
      `Cannot adopt the Drizzle migrations: ${String(applied.rows.length)} applied, ${String(adopted.length)} recognized`,
    );
  }
  for (const migration of adopted) {
    await client.query(
      `insert into schema_migrations (name, checksum) values ($1, $2)`,
      [migration.name, migration.checksum],
    );
  }
}

/** The migration names this process knows, in the order it applies them. */
export async function migrationNames(): Promise<string[]> {
  const files = await readMigrations(migrationsFolder());
  return files.map((file) => file.name);
}

/** Applies the pending migrations; returns the names it applied. */
export async function migrateDb(
  pool: pg.Pool,
  folder: string = migrationsFolder(),
): Promise<string[]> {
  const migrations = await readMigrations(folder);
  const client = await pool.connect();
  const ran: string[] = [];
  try {
    // A migration takes the time it needs: the pool's limits are for
    // requests, and an index built on a large table outlasts them.
    await client.query(`set statement_timeout = 0`);
    await client.query(`set lock_timeout = 0`);
    await client.query(`select pg_advisory_lock(hashtext($1))`, [LOCK]);
    await client.query(`
      create table if not exists schema_migrations (
        name text primary key,
        checksum text not null,
        applied_at timestamptz not null default now()
      )
    `);
    await adoptDrizzle(client, migrations);
    const applied = new Map(
      (
        await client.query<{ name: string; checksum: string }>(
          `select name, checksum from schema_migrations`,
        )
      ).rows.map((row) => [row.name, row.checksum]),
    );
    const known = new Set(migrations.map((migration) => migration.name));
    const unknown = [...applied.keys()].filter((name) => !known.has(name));
    if (unknown.length > 0) {
      throw new Error(
        `The database has migrations this version does not know: ${unknown.join(", ")}`,
      );
    }
    const pending: Migration[] = [];
    for (const migration of migrations) {
      const checksum = applied.get(migration.name);
      if (checksum === undefined) {
        pending.push(migration);
      } else if (checksum !== migration.checksum) {
        throw new Error(
          `Migration ${migration.name} changed after it was applied`,
        );
      }
    }
    // A database that holds nothing has nothing a check could refuse,
    // and none of the tables a check reads.
    if (applied.size > 0) await askChecks(client, pending);
    for (const migration of pending) {
      await client.query("begin");
      try {
        await client.query(migration.sql);
        await client.query(
          `insert into schema_migrations (name, checksum) values ($1, $2)`,
          [migration.name, migration.checksum],
        );
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw new Error(`Migration ${migration.name} failed`, {
          cause: error,
        });
      }
      ran.push(migration.name);
    }
  } finally {
    await client
      .query(`select pg_advisory_unlock(hashtext($1))`, [LOCK])
      .catch(() => undefined);
    // The connection goes back to the pool with the pool's limits.
    await client.query(`reset statement_timeout`).catch(() => undefined);
    await client.query(`reset lock_timeout`).catch(() => undefined);
    client.release();
  }
  return ran;
}
