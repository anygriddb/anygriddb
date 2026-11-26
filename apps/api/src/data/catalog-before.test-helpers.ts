/**
 * An older catalog to upgrade from: an empty database migrated as an
 * earlier version left it, and folders of migrations to run on it.
 */
import { randomBytes } from "node:crypto";
import { copyFile, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, migrateDb, type Database } from "@anygriddb/db";
import { sql } from "kysely";
import pg from "pg";
import { inject } from "vitest";

export const MIGRATIONS = fileURLToPath(
  new URL("../../../../packages/db/migrations/", import.meta.url),
);

/** A database that holds nothing, not even the record of a migration. */
export async function emptyDatabase() {
  const adminUrl = inject("adminUrl");
  const name = `catalog_upgrade_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return createDb(url.toString());
}

/** A folder of the migrations before `upTo`: what an earlier version ships. */
export async function migrationsBefore(upTo: string): Promise<string> {
  const earlier = await mkdtemp(join(tmpdir(), "migrations-"));
  for (const file of await readdir(MIGRATIONS)) {
    if (file.endsWith(".sql") && file < upTo) {
      await copyFile(join(MIGRATIONS, file), join(earlier, file));
    }
  }
  return earlier;
}

/** A folder of migrations written for one test. */
export async function migrationsOf(
  files: Record<string, string>,
): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "migrations-"));
  for (const [name, text] of Object.entries(files)) {
    await writeFile(join(folder, name), text);
  }
  return folder;
}

/** An empty database, migrated up to the file before `upTo`. */
export async function catalogBefore(upTo: string) {
  const created = await emptyDatabase();
  const earlier = await migrationsBefore(upTo);
  try {
    await migrateDb(created.pool, earlier);
  } finally {
    await rm(earlier, { recursive: true, force: true });
  }
  return created;
}

/**
 * A base made as a version before attributions (ADR 0131) made one: the
 * base, and its owner's role in `role_bindings`.
 */
export async function olderBase(
  db: Database,
  userId: string,
  name: string,
): Promise<{ id: string }> {
  return db.transaction().execute(async (tx) => {
    await sql`
      select set_config('anygrid.user_id', ${userId}, true),
        set_config('anygrid.source', 'test', true)
    `.execute(tx);
    const { rows } = await sql<{ id: string }>`
      insert into bases (name) values (${name}) returning id
    `.execute(tx);
    const id = rows[0]?.id ?? "";
    await sql`
      insert into role_bindings (user_id, role, scope, scope_id)
      values (${userId}, 'owner', 'base', ${id})
    `.execute(tx);
    return { id };
  });
}
