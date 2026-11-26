/**
 * What a process does to its database before it serves. Migrations are the
 * owner's: an application that signs in as a role of its own (ADR 0119)
 * changes nothing there, and only checks that they have run.
 */
import { migrateDb, migrationNames } from "@anygriddb/db";
import type pg from "pg";
import { migrationsCurrent } from "./readiness.js";
import { migrateQueue, type QueueLog } from "./queue/worker.js";

/** The migrations this version needs have not run on the database. */
export class DatabaseNotPrepared extends Error {
  constructor() {
    super(
      "This database has not been brought to this version, and the role AnyGridDB signs in as cannot do it. Run `anygriddb database prepare` with the owner's address (docs/operations.md).",
    );
    this.name = "DatabaseNotPrepared";
  }
}

/**
 * Whether this session's role owns the tables. A database with no such
 * function is one this version has not migrated yet, or an empty one: only
 * an owner can bring it there, and it says so if it is not one.
 */
export async function signsInAsOwner(
  pool: Pick<pg.Pool, "query">,
): Promise<boolean> {
  const found = await pool.query<{ fn: string | null }>(
    "select to_regprocedure('public.ag_role_owns_store(name)')::text as fn",
  );
  if (!found.rows[0]?.fn) return true;
  const { rows } = await pool.query<{ owns: boolean }>(
    "select public.ag_role_owns_store(current_user) as owns",
  );
  return rows[0]?.owns === true;
}

/** Refuses to start on a database a version behind this one. */
export async function assertPrepared(
  pool: Pick<pg.Pool, "query">,
): Promise<void> {
  const { rows } = await pool.query<{ name: string }>(
    "select name from schema_migrations",
  );
  const applied = rows.map((row) => row.name);
  if (!migrationsCurrent(applied, await migrationNames())) {
    throw new DatabaseNotPrepared();
  }
}

/** The migrations and the queue's schema: the owner's work. */
export async function migrateStore(
  pool: pg.Pool,
  connectionString: string,
  log: QueueLog,
): Promise<void> {
  // An operator accepts what a migration's check refused by naming it.
  await migrateDb(pool, undefined, {
    accept: process.env.ANYGRIDDB_ACCEPT_UPGRADE,
  });
  await migrateQueue(connectionString, log);
}
