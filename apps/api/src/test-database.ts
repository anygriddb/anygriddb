/**
 * A fresh database for one integration test file, copied from the
 * migrated template that `postgres-global.ts` prepares.
 */
import { randomBytes } from "node:crypto";
import { createDb } from "@anygriddb/db";
import pg from "pg";
import { inject } from "vitest";

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
  return { ...createDb(url.toString()), url: url.toString() };
}
