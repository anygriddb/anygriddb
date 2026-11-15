/**
 * A store that speaks the Redis wire protocol, read from a copy
 * (ADR 0088), against Valkey: an administering account is refused, a
 * reader copies the keys of one prefix, and a wrong password is refused.
 */
import { AppError } from "@anygriddb/core";
import Redis from "ioredis";
import { GenericContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SourceConnection } from "../types.js";
import { redis } from "./redis.js";

const IMAGE = "valkey/valkey:8.1.4";
const ADMIN_PASSWORD = "Server-key-91";
const READER_PASSWORD = "Reader-key-91";

function connection(
  port: number,
  username: string,
  password: string,
): SourceConnection {
  return {
    engine: "redis",
    host: "127.0.0.1",
    port,
    database: "shop:",
    username,
    password,
    tlsCa: null,
    queryTimeoutMs: 20_000,
  };
}

describe("redis against the server", () => {
  let port = 0;
  let stop: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const started = await new GenericContainer(IMAGE)
      .withCommand([
        "valkey-server",
        "--requirepass",
        ADMIN_PASSWORD,
        "--bind",
        "0.0.0.0",
        "--protected-mode",
        "no",
      ])
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
      .withStartupTimeout(120_000)
      .start();
    port = started.getMappedPort(6379);
    stop = async () => {
      await started.stop();
    };
    const admin = new Redis({
      host: "127.0.0.1",
      port,
      password: ADMIN_PASSWORD,
      maxRetriesPerRequest: 1,
    });
    try {
      await admin.call(
        "ACL",
        "SETUSER",
        "reader",
        "on",
        `>${READER_PASSWORD}`,
        "~shop:*",
        "+scan",
        "+type",
        "+get",
        "+hgetall",
        "+info",
        "+ping",
        "+hello",
        "+select",
        "+command",
      );
      // Every command but the ones that read or write the rules: it
      // cannot read its own rules, and still administers the server.
      await admin.call(
        "ACL",
        "SETUSER",
        "wide",
        "on",
        `>${READER_PASSWORD}`,
        "~*",
        "+@all",
        "-acl",
      );
      await admin.hset("shop:1", { sku: "A-1", qty: "2", paid: "true" });
      await admin.set("shop:2", JSON.stringify({ sku: "B-2", qty: 1 }));
      await admin.set("shop:3", "loose");
      await admin.set("other:1", "not this prefix");
    } finally {
      admin.disconnect();
    }
  }, 180_000);

  afterAll(async () => {
    await stop?.();
  });

  it("refuses an account that administers the server and a wrong password, and copies the prefix", async () => {
    await expect(
      redis.check(connection(port, "default", ADMIN_PASSWORD), {
        allowPlaintext: true,
      }),
    ).rejects.toMatchObject({ code: "source_admin_account" });

    await expect(
      redis.check(connection(port, "wide", READER_PASSWORD), {
        allowPlaintext: true,
      }),
    ).rejects.toMatchObject({ code: "source_admin_account" });

    await expect(
      redis.check(connection(port, "reader", "nope"), {
        allowPlaintext: true,
      }),
    ).rejects.toBeInstanceOf(AppError);

    const plain = connection(port, "reader", READER_PASSWORD);
    const found = await redis.check(plain, { allowPlaintext: true });
    expect(found.serverVersion).toMatch(/^Redis /);

    const tables = await redis.tables(plain, { allowPlaintext: true });
    expect(tables).toHaveLength(1);
    expect(tables[0]?.name).toBe("shop:");
    expect(tables[0]?.columns.map((column) => column.name).sort()).toEqual([
      "_key",
      "paid",
      "qty",
      "sku",
      "value",
    ]);

    const pages: string[] = [];
    for await (const page of redis.rows(
      plain,
      { allowPlaintext: true },
      {
        schema: "shop:",
        name: "shop:",
        key: ["_key"],
        fields: ["_key", "sku", "qty", "paid", "value"],
        pageSize: 2,
      },
    )) {
      expect(page.length).toBeLessThanOrEqual(2);
      for (const row of page) pages.push(row.id);
      const hash = page.find((row) => row.id === "shop:1");
      if (hash) {
        expect(hash.values.sku).toBe("A-1");
        expect(hash.values.qty).toBe(2);
        expect(hash.values.paid).toBe(true);
      }
    }
    expect(pages.sort()).toEqual(["shop:1", "shop:2", "shop:3"]);
  });
});
