/**
 * A client's database may end AnyGridDB's connections at any moment: it
 * restarts, a DBA terminates them, the database is dropped. The read or
 * write in flight fails; the process goes on.
 */
import { randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { keyRing } from "../auth/key-ring.js";
import { createTestDatabase } from "../test-database.js";
import { SourcePools } from "./pools.js";
import { createSource } from "./sources.js";

const settings = { allows: () => true, allowedHosts: [], allowPlaintext: true };

describe("source pools", () => {
  const key = keyRing(randomBytes(32));
  const admin = new pg.Client({ connectionString: inject("adminUrl") });
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let pools: SourcePools | undefined;
  let sourceId = "";
  const name = `erp_${randomBytes(4).toString("hex")}`;

  beforeAll(async () => {
    await admin.connect();
    await admin.query(`create database ${name}`);
    await admin
      .query("create role pools_reader login password 'readerpass'")
      .catch(() => undefined);
    const control = await createTestDatabase("pools");
    db = control.db;
    close = control.close;
    const actor = (
      await db
        .insertInto("users")
        .values({
          email: "admin@example.com",
          displayName: "Admin",
          isAdmin: true,
        })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;
    const url = new URL(inject("adminUrl"));
    sourceId = (
      await createSource({ db, key, settings }, actor, {
        name: "ERP",
        engine: "postgres",
        host: url.hostname,
        port: Number(url.port),
        database: name,
        username: "pools_reader",
        password: "readerpass",
        tlsCa: null,
        connectionLimit: 2,
        queryTimeoutMs: 15_000,
        timeZone: "UTC",
      })
    ).id;
    pools = new SourcePools({ db, key, settings, log: () => undefined });
  });

  afterAll(async () => {
    await pools?.close();
    await close?.();
    await admin.query(`drop database if exists ${name} with (force)`);
    await admin.end();
  });

  it("survives the client's database ending a connection mid-transaction", async () => {
    const failures: unknown[] = [];
    const uncaught = (error: unknown) => failures.push(error);
    process.on("uncaughtException", uncaught);
    try {
      const outcome = await pools
        ?.read(sourceId, async (run) => {
          const [row] = await run({
            text: "select pg_backend_pid() as pid",
            values: [],
          });
          await admin.query("select pg_terminate_backend($1)", [row?.pid]);
          // Between two queries, the connection has no query to fail.
          await new Promise((resolve) => setTimeout(resolve, 300));
          return run({ text: "select 1", values: [] });
        })
        .then(
          () => "read",
          () => "failed",
        );
      expect(outcome).toBe("failed");
      expect(failures).toEqual([]);
      // The pool replaced the connection: the next read works.
      const next = await pools?.read(sourceId, (run) =>
        run({ text: "select 1 as one", values: [] }),
      );
      expect(next).toEqual([{ one: 1 }]);
    } finally {
      process.off("uncaughtException", uncaught);
    }
  });
});
