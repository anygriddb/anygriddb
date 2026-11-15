/**
 * Neo4j, read from a copy (ADR 0088), against Community: an
 * administering account is refused, a reader copies the nodes of a
 * label, and relationships are not tables.
 */
import { AppError } from "@anygriddb/core";
import neo4j from "neo4j-driver";
import { GenericContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SourceConnection } from "../types.js";
import { neo4jStore } from "./neo4j.js";

const IMAGE = "neo4j:5.26-community";
const ADMIN_PASSWORD = "Neo4j-key-91";
const READER_PASSWORD = "Reader-key-91";

function connection(
  port: number,
  username: string,
  password: string,
): SourceConnection {
  return {
    engine: "neo4j",
    host: "127.0.0.1",
    port,
    database: "neo4j",
    username,
    password,
    tlsCa: null,
    queryTimeoutMs: 20_000,
  };
}

describe("neo4j against the server", () => {
  let port = 0;
  let stop: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const started = await new GenericContainer(IMAGE)
      .withEnvironment({
        NEO4J_AUTH: `neo4j/${ADMIN_PASSWORD}`,
        NEO4J_server_memory_heap_initial__size: "256m",
        NEO4J_server_memory_heap_max__size: "256m",
        NEO4J_server_memory_pagecache_size: "64m",
      })
      .withExposedPorts(7687)
      .withWaitStrategy(Wait.forLogMessage(/Started/))
      .withStartupTimeout(180_000)
      .start();
    port = started.getMappedPort(7687);
    stop = async () => {
      await started.stop();
    };
    const driver = neo4j.driver(
      `bolt://127.0.0.1:${String(port)}`,
      neo4j.auth.basic("neo4j", ADMIN_PASSWORD),
      { encrypted: "ENCRYPTION_OFF" },
    );
    const session = driver.session({ database: "neo4j" });
    try {
      await session.run(
        "CREATE USER reader SET PASSWORD $password CHANGE NOT REQUIRED",
        { password: READER_PASSWORD },
      );
      await session.run(
        "CREATE (:Order {sku: 'A-1', qty: 2, paid: true})-[:BOUGHT]->(:Person {name: 'Ada'})",
      );
      await session.run("CREATE (:Order {sku: 'B-2', qty: 1, paid: false})");
    } finally {
      await session.close();
      await driver.close();
    }
  }, 240_000);

  afterAll(async () => {
    await stop?.();
  });

  it("refuses the admin account and copies nodes, not relationships", async () => {
    await expect(
      neo4jStore.check(connection(port, "neo4j", ADMIN_PASSWORD), {
        allowPlaintext: true,
      }),
    ).rejects.toMatchObject({ code: "source_admin_account" });

    await expect(
      neo4jStore.check(connection(port, "reader", "nope"), {
        allowPlaintext: true,
      }),
    ).rejects.toBeInstanceOf(AppError);

    const plain = connection(port, "reader", READER_PASSWORD);
    const found = await neo4jStore.check(plain, { allowPlaintext: true });
    expect(found.serverVersion).toMatch(/^Neo4j /);

    const tables = await neo4jStore.tables(plain, { allowPlaintext: true });
    expect(tables.map((table) => table.name).sort()).toEqual([
      "Order",
      "Person",
    ]);
    const orders = tables.find((table) => table.name === "Order");
    expect(orders?.columns.map((column) => column.name).sort()).toEqual([
      "_id",
      "paid",
      "qty",
      "sku",
    ]);

    const pages: string[] = [];
    for await (const page of neo4jStore.rows(
      plain,
      { allowPlaintext: true },
      {
        schema: "neo4j",
        name: "Order",
        key: ["_id"],
        fields: ["_id", "sku", "qty", "paid"],
        pageSize: 1,
      },
    )) {
      expect(page).toHaveLength(1);
      const row = page[0];
      if (!row) continue;
      pages.push(String(row.values.sku));
      if (row.values.sku === "A-1") {
        expect(row.values.qty).toBe(2);
        expect(row.values.paid).toBe(true);
      }
    }
    expect(pages.sort()).toEqual(["A-1", "B-2"]);
  });
});
