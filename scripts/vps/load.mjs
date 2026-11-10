#!/usr/bin/env node
/**
 * Bootstrap an AnyGridDB VPS harness instance (signup → TOTP → base →
 * table → API token) then drive concurrent /health and /api/v1 row R/W.
 *
 * Usage:
 *   node scripts/vps/load.mjs [--base https://localhost:3100] [--seconds 30]
 *     [--concurrency 8] [--out path.json]
 *
 * TLS is verified: run it with NODE_EXTRA_CA_CERTS pointing at the
 * instance's authority (run.sh copies it to data/vps/authority.crt).
 */
import { createHmac, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEP_MS = 30_000;

function parseArgs(argv) {
  const out = {
    base: process.env.VPS_BASE_URL ?? "https://localhost:3100",
    seconds: 30,
    concurrency: 4,
    /** Cap /api/v1 calls (default under the 600/min rate limit). */
    apiRps: 8,
    out: null,
    bootstrapOnly: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--base") out.base = argv[++i];
    else if (arg === "--seconds") out.seconds = Number(argv[++i]);
    else if (arg === "--concurrency") out.concurrency = Number(argv[++i]);
    else if (arg === "--api-rps") out.apiRps = Number(argv[++i]);
    else if (arg === "--out") out.out = argv[++i];
    else if (arg === "--bootstrap-only") out.bootstrapOnly = true;
    else if (arg === "-h" || arg === "--help") {
      console.log(
        "Usage: load.mjs [--base URL] [--seconds N] [--concurrency N] [--api-rps N] [--out file] [--bootstrap-only]",
      );
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return out;
}

function makePacer(rps) {
  let nextSlot = 0;
  return async function pace() {
    if (!(rps > 0)) return;
    const now = Date.now();
    const slot = Math.max(now, nextSlot);
    nextSlot = slot + 1000 / rps;
    const wait = slot - now;
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  };
}

function decodeBase32(secret) {
  const normalized = secret.replace(/=+$/g, "").toUpperCase();
  let value = 0;
  let bits = 0;
  const bytes = [];
  for (const char of normalized) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error("invalid base32");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function totpCode(secretBase32, atMs = Date.now()) {
  const secret = decodeBase32(secretBase32);
  const counter = BigInt(Math.floor(atMs / STEP_MS));
  const counterBytes = Buffer.alloc(8);
  counterBytes.writeBigUInt64BE(counter);
  const hmac = createHmac("sha1", secret).update(counterBytes).digest();
  const offset = (hmac[hmac.length - 1] ?? 0) & 0xf;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    (hmac[offset + 1] << 16) |
    (hmac[offset + 2] << 8) |
    hmac[offset + 3];
  return String(binary % 1_000_000).padStart(6, "0");
}

export function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const rank = (p / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) return sorted[low];
  return sorted[low] + (sorted[high] - sorted[low]) * (rank - low);
}

export function summarizeLatencies(samplesMs) {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  return {
    count: sorted.length,
    min: sorted[0] ?? null,
    max: sorted[sorted.length - 1] ?? null,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
  };
}

function cookieHeader(jar) {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

function storeCookies(response, jar) {
  const lines =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [];
  for (const line of lines) {
    const pair = line.split(";", 1)[0];
    const eq = pair.indexOf("=");
    if (eq > 0) jar.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
}

async function request(base, jar, path, { method = "GET", body } = {}) {
  const headers = {};
  if (jar.size > 0) headers.cookie = cookieHeader(jar);
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(new URL(path, base), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  storeCookies(response, jar);
  const text = await response.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text.slice(0, 500) };
    }
  }
  return { status: response.status, json, text };
}

async function trpc(base, jar, path, input) {
  const reply = await request(base, jar, `/trpc/${path}`, {
    method: "POST",
    body: input,
  });
  if (reply.status >= 400 || reply.json?.error) {
    const detail = JSON.stringify(reply.json).slice(0, 400);
    throw new Error(`tRPC ${path} failed (${reply.status}): ${detail}`);
  }
  return reply.json?.result?.data;
}

async function bootstrap(base) {
  const jar = new Map();
  const stamp = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
  const email = `vps-${stamp}@example.com`;
  const password = "correct-horse-battery";

  await trpc(base, jar, "auth.signup", {
    email,
    displayName: "VPS Load",
    password,
  });

  const begun = await trpc(base, jar, "auth.totp.begin", {});
  await trpc(base, jar, "auth.totp.confirm", {
    secret: begun.secret,
    code: totpCode(begun.secret),
  });

  const baseRow = await trpc(base, jar, "catalog.createBase", {
    name: "VPS Bench",
  });
  const table = await trpc(base, jar, "catalog.createTable", {
    baseId: baseRow.id,
    name: "Items",
    columns: [{ name: "title", label: "Title", fieldType: "text" }],
  });
  const tokenRow = await trpc(base, jar, "auth.createToken", {
    name: "vps-load",
    baseIds: [baseRow.id],
  });

  return {
    email,
    baseId: baseRow.id,
    tableId: table.id,
    token: tokenRow.token,
  };
}

async function timed(fn) {
  const start = performance.now();
  try {
    const result = await fn();
    return { ok: true, ms: performance.now() - start, result };
  } catch (error) {
    return {
      ok: false,
      ms: performance.now() - start,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function apiFetch(base, token, path, { method = "GET", body } = {}) {
  const headers = { authorization: `Bearer ${token}` };
  if (body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(new URL(path, base), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `${method} ${path} → ${response.status} ${text.slice(0, 200)}`,
    );
  }
  return text ? JSON.parse(text) : null;
}

async function runLoad(opts, ctx) {
  const deadline = Date.now() + opts.seconds * 1000;
  const healthMs = [];
  const readMs = [];
  const writeMs = [];
  let healthErrors = 0;
  let readErrors = 0;
  let writeErrors = 0;
  let writes = 0;
  let reads = 0;
  let healthOk = 0;
  const paceApi = makePacer(opts.apiRps);

  async function worker(id) {
    while (Date.now() < deadline) {
      const health = await timed(async () => {
        const reply = await fetch(new URL("/health", opts.base));
        if (!reply.ok) throw new Error(`health ${reply.status}`);
        return reply.json();
      });
      healthMs.push(health.ms);
      if (health.ok) healthOk++;
      else healthErrors++;

      await paceApi();
      const write = await timed(() =>
        apiFetch(
          opts.base,
          ctx.token,
          `/api/v1/tables/${ctx.tableId}/records`,
          {
            method: "POST",
            body: {
              records: [{ fields: { title: `row-${id}-${writes}` } }],
            },
          },
        ),
      );
      writeMs.push(write.ms);
      if (write.ok) writes++;
      else writeErrors++;

      await paceApi();
      const read = await timed(() =>
        apiFetch(
          opts.base,
          ctx.token,
          `/api/v1/tables/${ctx.tableId}/records?limit=50`,
        ),
      );
      readMs.push(read.ms);
      if (read.ok) reads++;
      else readErrors++;
    }
  }

  await Promise.all(
    Array.from({ length: opts.concurrency }, (_, i) => worker(i)),
  );

  return {
    seconds: opts.seconds,
    concurrency: opts.concurrency,
    health: {
      ok: healthOk,
      errors: healthErrors,
      latency: summarizeLatencies(healthMs),
    },
    write: {
      ok: writes,
      errors: writeErrors,
      latency: summarizeLatencies(writeMs),
    },
    read: {
      ok: reads,
      errors: readErrors,
      latency: summarizeLatencies(readMs),
    },
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const started = new Date().toISOString();
  console.error(`bootstrap against ${opts.base}`);
  const ctx = await bootstrap(opts.base);
  console.error(`ready base=${ctx.baseId} table=${ctx.tableId}`);

  let load = null;
  if (!opts.bootstrapOnly) {
    console.error(`load ${opts.seconds}s concurrency=${opts.concurrency}`);
    load = await runLoad(opts, ctx);
  }

  const report = {
    started,
    finished: new Date().toISOString(),
    baseUrl: opts.base,
    // Measured here only: what the server sent (ids, bodies) stays out of
    // the file; the base and table are on the console.
    bootstrap: { email: ctx.email },
    load,
  };

  const json = JSON.stringify(report, null, 2);
  if (opts.out) writeFileSync(opts.out, `${json}\n`);
  else console.log(json);
}

const isMain =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
