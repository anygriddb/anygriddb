/**
 * Fills the lab's stores that speak no SQL (ADR 0088) with made-up data:
 * a shop's orders, products and events in FerretDB, and its orders in
 * OpenSearch, the same at every run. Started by
 * `scripts/lab/seed.sh --stores`.
 *
 * LAB_STORE_ROWS sets how many orders (50,000 by default); the events are
 * twice as many, so a million orders also tries what a copy refuses.
 */
import { readFileSync } from "node:fs";
import https from "node:https";
import { Decimal128, Long, MongoClient, ObjectId } from "mongodb";

const HOST = process.env.LAB_HOST ?? "127.0.0.1";
const PASSWORD = process.env.LAB_PASSWORD ?? "Lab!Admin-2026";
const CA = readFileSync(
  process.env.ANYGRIDDB_LAB_TLS_CA ?? "../../docker/lab/certs/ca.crt",
  "utf8",
);
const ORDERS = Number(process.env.LAB_STORE_ROWS ?? 50_000);
/** The lab OpenSearch's own administrator (docker/lab/compose.yml). */
const SEARCH_ADMIN_PASSWORD =
  process.env.LAB_OPENSEARCH_ADMIN_PASSWORD ?? "Harbor-Ledger-Kiwi-58!"; // NOSONAR: the throwaway lab's made-up default (docker/lab/compose.yml)
const BATCH = 5_000;

/** The same numbers at every run. */
function generator(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0; // NOSONAR: Mulberry32 wraps to 32 bits, Math.trunc would not
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const CITIES = ["Lyon", "Nantes", "Lille", "Turin", "Porto", "Gand", "Graz"];
const STATUSES = ["new", "paid", "packed", "sent", "returned"];
const TAGS = ["gift", "fragile", "express", "export", "bulk"];

/** An id that grows with the order, as MongoDB's own do. */
function orderId(index: number): ObjectId {
  const seconds = 1_735_689_600 + index * 20;
  return new ObjectId(
    seconds.toString(16).padStart(8, "0") +
      index.toString(16).padStart(16, "0"),
  );
}

async function fill<T>(
  count: number,
  make: (index: number) => T,
  insert: (batch: T[]) => Promise<unknown>,
): Promise<void> {
  for (let start = 0; start < count; start += BATCH) {
    const size = Math.min(BATCH, count - start);
    await insert(Array.from({ length: size }, (_, at) => make(start + at)));
  }
}

async function seedDocuments(): Promise<void> {
  const client = new MongoClient(`mongodb://${HOST}:57017/`, {
    auth: { username: "ferretdb", password: PASSWORD },
    directConnection: true,
    tls: true,
    ca: CA,
    serverSelectionTimeoutMS: 30_000,
  });
  await client.connect();
  try {
    const shop = client.db("shop");
    await shop.dropDatabase();
    const random = generator(2026);
    await fill(
      500,
      (index) => ({
        _id: `SKU-${String(index).padStart(4, "0")}`,
        name: `Product ${String(index)}`,
        price: Decimal128.fromString((5 + random() * 495).toFixed(2)),
        stock: Math.floor(random() * 1_000),
        tags: TAGS.filter(() => random() < 0.3),
        discontinued: random() < 0.1,
      }),
      (batch) => shop.collection<{ _id: string }>("products").insertMany(batch),
    );
    await fill(
      ORDERS,
      (index) => {
        const customer = Math.floor(random() * 5_000);
        const lines = Array.from(
          { length: 1 + Math.floor(random() * 4) },
          () => ({
            sku: `SKU-${String(Math.floor(random() * 500)).padStart(4, "0")}`,
            quantity: 1 + Math.floor(random() * 5),
          }),
        );
        return {
          _id: orderId(index),
          number: index + 1,
          status: STATUSES[Math.floor(random() * STATUSES.length)],
          placedAt: new Date(1_735_689_600_000 + index * 20_000),
          total: Decimal128.fromString((10 + random() * 990).toFixed(2)),
          paid: random() < 0.8,
          weight: Math.round(random() * 20_000) / 1_000,
          ledger: Long.fromNumber(9_000_000_000_000 + index),
          customer: {
            name: `Customer ${String(customer)}`,
            email: `customer${String(customer)}@example.org`,
            city: CITIES[customer % CITIES.length],
          },
          lines,
          ...(random() < 0.05
            ? {
                note: `Leave with the neighbour.\nCall first: order ${String(index + 1)}.`,
              }
            : {}),
          // Older orders say nothing of their channel; a few say it badly.
          ...(index > ORDERS / 2
            ? {
                channel:
                  index % 997 === 0 ? 3 : random() < 0.5 ? "web" : "shop",
              }
            : {}),
        };
      },
      (batch) =>
        shop.collection("orders").insertMany(batch, { ordered: false }),
    );
    await fill(
      ORDERS * 2,
      (index) => ({
        _id: Long.fromNumber(index + 1),
        order: Math.floor(random() * ORDERS) + 1,
        kind: random() < 0.5 ? "viewed" : "changed",
        at: new Date(1_735_689_600_000 + index * 7_000),
      }),
      (batch) =>
        shop
          .collection<{ _id: Long }>("events")
          .insertMany(batch, { ordered: false }),
    );
    // The account AnyGridDB reads with.
    await shop.command({ dropUser: "anygriddb" }).catch(() => undefined);
    await shop.command({
      createUser: "anygriddb",
      pwd: PASSWORD,
      roles: [{ role: "read", db: "shop" }],
    });
    console.log(
      `shop: 500 products, ${String(ORDERS)} orders, ${String(ORDERS * 2)} events`,
    );
  } finally {
    await client.close();
  }
}

/** One call to the lab's OpenSearch, through its TLS front, as its admin. */
function search(
  method: string,
  path: string,
  body?: string,
  type = "application/json",
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        host: HOST,
        port: 59243,
        method,
        path,
        // The lab's authority is trusted through NODE_EXTRA_CA_CERTS, which
        // scripts/lab/seed.sh sets: Node reads it once, at start.
        timeout: 60_000,
        auth: `admin:${SEARCH_ADMIN_PASSWORD}`,
        headers: body === undefined ? {} : { "content-type": type },
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          text += chunk;
        });
        response.on("end", () => {
          resolve({ status: response.statusCode ?? 0, text });
        });
      },
    );
    request.on("timeout", () => {
      request.destroy(new Error("OpenSearch did not answer"));
    });
    request.on("error", reject);
    request.end(body);
  });
}

async function searchOk(
  method: string,
  path: string,
  body?: unknown,
): Promise<void> {
  const answer = await search(
    method,
    path,
    body === undefined ? undefined : JSON.stringify(body),
  );
  if (answer.status >= 300) {
    throw new Error(`OpenSearch ${method} ${path}: ${String(answer.status)}`);
  }
}

async function seedSearch(): Promise<void> {
  const random = generator(2027);
  const count = Math.min(ORDERS, 20_000);
  await search("DELETE", "/orders");
  await searchOk("PUT", "/orders", {
    mappings: {
      properties: {
        number: { type: "integer" },
        status: { type: "keyword" },
        placedAt: { type: "date" },
        total: { type: "scaled_float", scaling_factor: 100 },
        paid: { type: "boolean" },
        city: { type: "keyword" },
        tags: { type: "keyword" },
        note: { type: "text" },
      },
    },
  });
  for (let start = 0; start < count; start += BATCH) {
    const lines: string[] = [];
    for (
      let index = start;
      index < Math.min(start + BATCH, count);
      index += 1
    ) {
      lines.push(JSON.stringify({ index: { _id: `O-${String(index + 1)}` } }));
      lines.push(
        JSON.stringify({
          number: index + 1,
          status: STATUSES[Math.floor(random() * STATUSES.length)],
          placedAt: new Date(1_735_689_600_000 + index * 20_000).toISOString(),
          total: Math.round((10 + random() * 990) * 100) / 100,
          paid: random() < 0.8,
          city: CITIES[index % CITIES.length],
          tags: TAGS.filter(() => random() < 0.3),
          ...(random() < 0.05
            ? { note: `Leave with the neighbour.\nOrder ${String(index + 1)}.` }
            : {}),
        }),
      );
    }
    const answer = await search(
      "POST",
      "/orders/_bulk?refresh=false",
      `${lines.join("\n")}\n`,
      "application/x-ndjson",
    );
    if (answer.status >= 300 || answer.text.includes('"errors":true')) {
      throw new Error(`OpenSearch bulk: ${String(answer.status)}`);
    }
  }
  await searchOk("POST", "/orders/_refresh");
  // The account AnyGridDB reads with: the orders, and nothing to change.
  await searchOk("PUT", "/_plugins/_security/api/internalusers/anygriddb", {
    password: PASSWORD,
  });
  await searchOk("PUT", "/_plugins/_security/api/roles/anygriddb_reader", {
    cluster_permissions: ["cluster_composite_ops_ro", "cluster:monitor/main"],
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
  });
  await searchOk(
    "PUT",
    "/_plugins/_security/api/rolesmapping/anygriddb_reader",
    { users: ["anygriddb"] },
  );
  console.log(`orders index: ${String(count)} orders`);
}

const only = new Set(
  (process.env.LAB_SEED_ONLY ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0),
);
const wanted = (name: string) => only.size === 0 || only.has(name);

if (wanted("documents")) await seedDocuments();
if (wanted("opensearch")) await seedSearch();
