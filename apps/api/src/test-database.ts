/**
 * A fresh database for one integration test file, copied from the
 * migrated template that `postgres-global.ts` prepares. What it hands out
 * signs in as the application does, as a role that owns no table
 * (ADR 0119); `owner` is for what a test does in a migration's place.
 */
import { randomBytes } from "node:crypto";
import { createDb } from "@anygriddb/db";
import pg from "pg";
import { inject } from "vitest";

/** The role integration tests sign in as, made by `postgres-global.ts`. */
export const RUNTIME_ROLE = "anygriddb_app";

export async function createTestDatabase(prefix: string) {
  const adminUrl = inject("adminUrl");
  const name = `${prefix}_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(
      `CREATE DATABASE "${name}" TEMPLATE "${inject("templateDatabase")}"`,
    );
  } finally {
    await admin.end();
  }
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const ownerUrl = url.toString();
  url.username = RUNTIME_ROLE;
  url.password = RUNTIME_ROLE;
  const application = createDb(url.toString());
  const owner = createDb(ownerUrl);
  return {
    ...application,
    url: url.toString(),
    owner: { db: owner.db, pool: owner.pool, url: ownerUrl },
    close: async () => {
      await application.close();
      await owner.close();
    },
  };
}
