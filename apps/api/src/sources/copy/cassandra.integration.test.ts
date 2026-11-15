/**
 * Cassandra, read from a copy (ADR 0088), against the real server: a
 * keyspace's rows are copied by pages. The image ships with
 * authentication off, which the connector reads when the server says
 * nothing about roles.
 */
import { Client } from "cassandra-driver";
import { GenericContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SourceConnection } from "../types.js";
import { cassandra } from "./cassandra.js";

const IMAGE = "cassandra:5.0";

function connection(port: number, password: string): SourceConnection {
  return {
    engine: "cassandra",
    host: "127.0.0.1",
    port,
    database: "shop",
    username: "cassandra",
    password,
    tlsCa: null,
    queryTimeoutMs: 20_000,
  };
}

describe("cassandra against the server", () => {
  let port = 0;
  let stop: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const started = await new GenericContainer(IMAGE)
      .withExposedPorts(9042)
      .withWaitStrategy(Wait.forLogMessage(/Startup complete/))
      .withStartupTimeout(240_000)
      .start();
    port = started.getMappedPort(9042);
    stop = async () => {
      await started.stop();
    };
    const client = new Client({
      contactPoints: [`127.0.0.1:${String(port)}`],
      localDataCenter: "datacenter1",
    });
    try {
      await client.connect();
      await client.execute(
        "CREATE KEYSPACE shop WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1}",
      );
      await client.execute(
        "CREATE TABLE shop.orders (id text PRIMARY KEY, qty int, paid boolean, note text)",
      );
      for (const row of [
        ["a", 2, true, "short"],
        ["b", 1, false, "x"],
        ["c", 4, true, "y"],
      ]) {
        await client.execute(
          "INSERT INTO shop.orders (id, qty, paid, note) VALUES (?, ?, ?, ?)",
          row,
          { prepare: true },
        );
      }
    } finally {
      await client.shutdown();
    }
  }, 300_000);

  afterAll(async () => {
    await stop?.();
  });

  it("copies the keyspace by pages", async () => {
    const plain = connection(port, "cassandra");
    const found = await cassandra.check(plain, { allowPlaintext: true });
    expect(found.serverVersion).toMatch(/^Cassandra /);

    const tables = await cassandra.tables(plain, { allowPlaintext: true });
    const orders = tables.find((table) => table.name === "orders");
    expect(orders?.primaryKey).toEqual(["id"]);
    expect(orders?.columns.map((column) => column.name).sort()).toEqual([
      "id",
      "note",
      "paid",
      "qty",
    ]);

    const pages: string[] = [];
    for await (const page of cassandra.rows(
      plain,
      { allowPlaintext: true },
      {
        schema: "shop",
        name: "orders",
        key: ["id"],
        fields: ["id", "qty", "paid", "note"],
        pageSize: 2,
      },
    )) {
      expect(page.length).toBeLessThanOrEqual(2);
      for (const row of page) {
        pages.push(row.id);
        if (row.id === "a") {
          expect(row.values.qty === 2 || row.values.qty === "2").toBe(true);
          expect(row.values.paid).toBe(true);
          expect(row.values.note).toBe("short");
        }
      }
    }
    expect(pages.sort()).toEqual(["a", "b", "c"]);
  });
});
