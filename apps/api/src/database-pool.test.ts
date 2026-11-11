import { createDb, POOL_WAIT_MS } from "@anygriddb/db";
import { createServer, type AddressInfo, type Socket } from "node:net";
import { describe, expect, it } from "vitest";

describe("the database pool", () => {
  it("waits for a connection at most its time limit by default", async () => {
    const { pool, close } = createDb("postgres://ag:ag@127.0.0.1:1/ag");
    expect(pool.options.connectionTimeoutMillis).toBe(POOL_WAIT_MS);
    await close();
  });

  it("gives up on a database that accepts the connection and never answers", async () => {
    const sockets: Socket[] = [];
    const server = createServer((socket) => {
      sockets.push(socket);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const { port } = server.address() as AddressInfo;
    const { pool, close } = createDb(
      `postgres://ag:ag@127.0.0.1:${String(port)}/ag`,
      { waitMs: 200 },
    );
    const started = Date.now();
    await expect(pool.query("select 1")).rejects.toThrow(/timeout/i);
    expect(Date.now() - started).toBeLessThan(5_000);
    await close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });
});
