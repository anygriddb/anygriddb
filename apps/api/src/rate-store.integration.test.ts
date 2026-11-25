/**
 * Requests counted in PostgreSQL (ADR 0132): two processes of one
 * instance count the same requests, so a limit is the limit however many
 * serve; a window that ended is forgotten.
 */
import type { Database } from "@anygriddb/db";
import Fastify, { type FastifyInstance } from "fastify";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RATE_LIMITS, registerRateLimit } from "./rate-limit.js";
import { pruneRateWindows, rateStoreIn } from "./rate-store.js";
import { createTestDatabase } from "./test-database.js";

describe("requests counted where every process sees them", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  const servers: FastifyInstance[] = [];

  /** A process of the instance: its own server, the instance's database. */
  async function process(
    counting: Database = db,
    warn: (error: unknown) => void = () => undefined,
  ): Promise<FastifyInstance> {
    const server = Fastify();
    await registerRateLimit(server, {
      store: rateStoreIn(counting, { warn }),
      prune: (timeWindow) => pruneRateWindows(counting, timeWindow),
      values: async () => ({}),
    });
    server.post("/api/client-errors", () => ({ ok: true }));
    server.get("/health", () => ({ ok: true }));
    await server.ready();
    servers.push(server);
    return server;
  }

  beforeAll(async () => {
    const created = await createTestDatabase("rate_windows");
    db = created.db;
    close = created.close;
  }, 120_000);

  afterAll(async () => {
    for (const server of servers) await server.close();
    await close?.();
  });

  it("refuses one request too many, whichever process it reaches", async () => {
    const [first, second] = [await process(), await process()];
    const send = (server: FastifyInstance) =>
      server.inject({
        method: "POST",
        url: "/api/client-errors",
        remoteAddress: "203.0.113.20",
      });
    for (let sent = 0; sent < RATE_LIMITS.report; sent += 1) {
      const answer = await send(sent % 2 === 0 ? first : second);
      expect(answer.statusCode, String(sent)).toBe(200);
    }
    // Each process saw half: counted apart, both would still take more.
    expect((await send(first)).statusCode).toBe(429);
    expect((await send(second)).statusCode).toBe(429);
    // Another address is another count.
    const other = await first.inject({
      method: "POST",
      url: "/api/client-errors",
      remoteAddress: "203.0.113.21",
    });
    expect(other.statusCode).toBe(200);
  });

  it("does not count the probes, which must answer without the database", async () => {
    const server = await process();
    for (let sent = 0; sent < 3; sent += 1) {
      await server.inject({
        method: "GET",
        url: "/health",
        remoteAddress: "203.0.113.30",
      });
    }
    const { rows } = await sql<{ n: number }>`
      select count(*)::int as n from rate_windows where "key" like '203.0.113.30:%'
    `.execute(db);
    expect(rows[0]?.n).toBe(0);
  });

  it("lets a request through when its count cannot be taken, and says so once", async () => {
    const gone = await createTestDatabase("rate_windows_gone");
    await gone.close();
    const warned: unknown[] = [];
    const server = await process(gone.db, (error) => warned.push(error));
    for (let sent = 0; sent < 3; sent += 1) {
      const answer = await server.inject({
        method: "POST",
        url: "/api/client-errors",
        remoteAddress: "203.0.113.31",
      });
      expect(answer.statusCode).toBe(200);
    }
    expect(warned).toHaveLength(1);
  }, 120_000);

  it("forgets the windows that ended", async () => {
    await sql`
      insert into rate_windows ("key", window_start, hits)
      values ('old', now() - interval '1 hour', 5)
    `.execute(db);
    await pruneRateWindows(db, 60_000);
    const { rows } = await sql<{ n: number }>`
      select count(*)::int as n from rate_windows where "key" = 'old'
    `.execute(db);
    expect(rows[0]?.n).toBe(0);
  });
});
