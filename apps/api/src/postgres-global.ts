import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { createDb, migrateDb } from "@anygriddb/db";
import pg from "pg";
import type { TestProject } from "vitest/node";
import { migrateQueue } from "./queue/worker.js";

const TEMPLATE_DATABASE = "anygriddb_template";

async function waitForNoSessions(databaseUrl: string): Promise<void> {
  const target = new URL(databaseUrl);
  const name = target.pathname.slice(1);
  const admin = new URL(databaseUrl);
  admin.pathname = "/postgres";
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const { rows } = await client.query<{ count: number }>(
        "select count(*)::int as count from pg_stat_activity where datname = $1",
        [name],
      );
      if ((rows[0]?.count ?? 0) === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Sessions still open on ${name}`);
  } finally {
    await client.end();
  }
}

export default async function setup(
  project: TestProject,
): Promise<() => Promise<void>> {
  const container = await new PostgreSqlContainer("postgres:18")
    .withDatabase("anygriddb")
    .withUsername("anygriddb")
    .withPassword("anygriddb")
    .start();

  const { pool, close } = createDb(container.getConnectionUri());
  try {
    await migrateDb(pool);
  } finally {
    await close();
  }
  const quiet = () => undefined;
  await migrateQueue(container.getConnectionUri(), {
    error: quiet,
    warn: quiet,
    info: quiet,
    debug: quiet,
  });
  // A closed pool returns before the server ends its sessions; a template
  // must have none.
  await waitForNoSessions(container.getConnectionUri());
  await container.snapshot(TEMPLATE_DATABASE);

  const admin = new URL(container.getConnectionUri());
  admin.pathname = "/postgres";
  project.provide("adminUrl", admin.toString());
  project.provide("templateDatabase", TEMPLATE_DATABASE);

  return async () => {
    await container.stop();
  };
}
