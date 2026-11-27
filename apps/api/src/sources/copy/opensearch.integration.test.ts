/**
 * OpenSearch 2, read from a copy (ADR 0088), against the real server:
 * an administering account is refused, a reader copies every document
 * across two pages, and a wrong password is refused.
 */
import { AppError } from "@anygriddb/core";
import { GenericContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SourceConnection } from "../types.js";
import { opensearch } from "./opensearch.js";

const IMAGE = "opensearchproject/opensearch:2.19.7";
const ADMIN_PASSWORD = "Cluster-key-91";
const READER_PASSWORD = "Index-key-91";

function connection(
  port: number,
  username: string,
  password: string,
): SourceConnection {
  return {
    engine: "opensearch",
    host: "127.0.0.1",
    port,
    database: "orders",
    username,
    password,
    tlsCa: null,
    allowPlaintext: false,
    queryTimeoutMs: 20_000,
  };
}

async function ask(
  port: number,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      authorization: `Basic ${Buffer.from(`admin:${ADMIN_PASSWORD}`, "utf8").toString("base64")}`,
      accept: "application/json",
      ...(payload ? { "content-type": "application/json" } : {}),
    },
    body: payload,
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text.length > 0 ? (JSON.parse(text) as unknown) : null,
  };
}

describe("opensearch against the server", () => {
  let port = 0;
  let stop: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const started = await new GenericContainer(IMAGE)
      .withEnvironment({
        "discovery.type": "single-node",
        OPENSEARCH_INITIAL_ADMIN_PASSWORD: ADMIN_PASSWORD,
        // HTTP stays open so the test can sign in; the transport keeps
        // the image's own certificates. Disabling the demo config removes
        // those certificates and the process refuses to start.
        "plugins.security.ssl.http.enabled": "false",
        OPENSEARCH_JAVA_OPTS: "-Xms512m -Xmx512m",
      })
      .withExposedPorts(9200)
      .withWaitStrategy(
        Wait.forHttp("/", 9200)
          .withBasicCredentials("admin", ADMIN_PASSWORD)
          .forStatusCode(200),
      )
      .withStartupTimeout(240_000)
      .start();
    port = started.getMappedPort(9200);
    stop = async () => {
      await started.stop();
    };

    const user = await ask(
      port,
      "PUT",
      "/_plugins/_security/api/internalusers/reader",
      { password: READER_PASSWORD },
    );
    expect(user.status).toBeLessThan(300);
    const role = await ask(
      port,
      "PUT",
      "/_plugins/_security/api/roles/reader",
      {
        cluster_permissions: [
          "cluster_composite_ops_ro",
          "cluster:monitor/main",
        ],
        index_permissions: [
          {
            index_patterns: ["orders"],
            allowed_actions: [
              "indices:data/read/*",
              "indices:admin/mappings/get",
              "indices:admin/get",
              "indices:monitor/stats",
            ],
          },
        ],
      },
    );
    expect(role.status).toBeLessThan(300);
    const mapping = await ask(
      port,
      "PUT",
      "/_plugins/_security/api/rolesmapping/reader",
      { users: ["reader"] },
    );
    expect(mapping.status).toBeLessThan(300);
  }, 240_000);

  afterAll(async () => {
    await stop?.();
  });

  it("refuses the admin account and a wrong password, and copies the index", async () => {
    await expect(
      opensearch.check(connection(port, "admin", ADMIN_PASSWORD), {
        allowPlaintext: true,
      }),
    ).rejects.toMatchObject({ code: "source_admin_account" });

    await expect(
      opensearch.check(connection(port, "reader", "nope"), {
        allowPlaintext: true,
      }),
    ).rejects.toBeInstanceOf(AppError);

    const plain = connection(port, "reader", READER_PASSWORD);
    const found = await opensearch.check(plain, { allowPlaintext: true });
    expect(found.serverVersion).toMatch(/^OpenSearch 2\./);

    const created = await ask(port, "PUT", "/orders", {
      mappings: {
        properties: {
          sku: { type: "keyword" },
          qty: { type: "integer" },
          paid: { type: "boolean" },
          note: { type: "text" },
          ship: { type: "object" },
        },
      },
    });
    expect(created.status).toBeLessThan(300);

    const ndjson = [
      JSON.stringify({ index: { _id: "a" } }),
      JSON.stringify({
        sku: "A-1",
        qty: 2,
        paid: true,
        note: "short",
        ship: { city: "Lyon" },
      }),
      JSON.stringify({ index: { _id: "b" } }),
      JSON.stringify({ sku: "B-2", qty: 1, paid: false, note: "x" }),
      JSON.stringify({ index: { _id: "c" } }),
      JSON.stringify({ sku: "C-3", qty: 4, paid: true, note: "y" }),
      "",
    ].join("\n");
    const response = await fetch(
      `http://127.0.0.1:${port}/orders/_bulk?refresh=true`,
      {
        method: "POST",
        headers: {
          authorization: `Basic ${Buffer.from(`admin:${ADMIN_PASSWORD}`, "utf8").toString("base64")}`,
          "content-type": "application/x-ndjson",
        },
        body: ndjson,
      },
    );
    expect(response.ok).toBe(true);

    const { tables } = await opensearch.tables(plain, {
      allowPlaintext: true,
    });
    const orders = tables.find((table) => table.name === "orders");
    expect(orders?.columns.map((column) => column.name).sort()).toEqual([
      "_id",
      "note",
      "paid",
      "qty",
      "ship",
      "sku",
    ]);
    const ship = orders?.columns.find((column) => column.name === "ship");
    expect(ship?.field.fieldType).toBe("json");

    const pages: string[] = [];
    for await (const page of opensearch.rows(
      plain,
      { allowPlaintext: true },
      {
        schema: "indices",
        name: "orders",
        key: ["_id"],
        fields: ["_id", "sku", "qty", "paid", "note", "ship"],
        pageSize: 2,
      },
    )) {
      expect(page.length).toBeLessThanOrEqual(2);
      for (const row of page) pages.push(row.id);
      const first = page.find((row) => row.id === "a");
      if (first) {
        expect(first.values.sku).toBe("A-1");
        expect(first.values.qty).toBe(2);
        expect(first.values.paid).toBe(true);
        expect(first.values.ship).toBe(JSON.stringify({ city: "Lyon" }));
      }
    }
    expect(pages.sort()).toEqual(["a", "b", "c"]);
  });
});
