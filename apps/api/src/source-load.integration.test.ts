/**
 * Load by source (ROADMAP #41): minute buckets every process writes.
 */
import { giveInstanceRole } from "./auth/instance-roles.test-helpers.js";
import { randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withAudit } from "./data/audit-context.js";
import { createTestDatabase } from "./test-database.js";
import {
  purgeSourceLoad,
  readSourceLoad,
  recordSourceLoad,
  registerSourceLoadWriter,
  SOURCE_LOAD_SLOW_MS,
} from "./source-load.js";

const suffix = randomBytes(6).toString("hex");

describe("source load buckets", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let sourceId = "";

  beforeAll(async () => {
    const created = await createTestDatabase("source_load");
    db = created.db;
    close = created.close;
    registerSourceLoadWriter(db);
    const admin = (
      await db
        .insertInto("users")
        .values({
          email: `load-${suffix}@example.org`,
          displayName: "Load",
        })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;
    await giveInstanceRole(db, admin);
    sourceId = await withAudit(db, { userId: admin, source: "test" }, (tx) =>
      tx
        .insertInto("sources")
        .values({
          name: `Warehouse ${suffix}`,
          engine: "postgres",
          host: "db.example.org",
          port: 5432,
          database: "warehouse",
          username: "reader",
          passwordCiphertext: Buffer.from("x"),
          passwordNonce: Buffer.from("n".repeat(12)),
          createdBy: admin,
        })
        .returning("id")
        .executeTakeFirstOrThrow()
        .then((row) => row.id),
    );
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  it("aggregates ops, errors, timeouts and slow calls", async () => {
    await recordSourceLoad({
      sourceId,
      kind: "read",
      outcome: "ok",
      durationMs: 20,
    });
    await recordSourceLoad({
      sourceId,
      kind: "read",
      outcome: "error",
      durationMs: 50,
    });
    await recordSourceLoad({
      sourceId,
      kind: "write",
      outcome: "timeout",
      durationMs: SOURCE_LOAD_SLOW_MS + 5,
    });
    const figures = await readSourceLoad(db, 7);
    const row = figures.sources.find((item) => item.sourceId === sourceId);
    expect(row).toBeDefined();
    expect(row?.ops).toBe(3);
    expect(row?.errors).toBe(1);
    expect(row?.timeouts).toBe(1);
    expect(row?.slow).toBe(1);
  });

  it("purges minute buckets older than the keep window", async () => {
    await sql`
      insert into source_load_minute (
        source_id, minute, kind, ops, errors, timeouts, slow, total_ms
      ) values (
        ${sourceId}::uuid,
        now() - interval '40 days',
        'read',
        1, 0, 0, 0, 10
      )
      on conflict do nothing
    `.execute(db);
    expect(await purgeSourceLoad(db)).toBeGreaterThanOrEqual(1);
  });
});
