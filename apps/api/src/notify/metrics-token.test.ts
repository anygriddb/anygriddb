import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Database } from "@anygriddb/db";
import { encryptSecret } from "../auth/crypto.js";
import { keyRing } from "../auth/key-ring.js";
import type { Env } from "../env.js";
import { clearMetricsBearer, metricsBearer } from "./metrics-token.js";

function database(row: unknown, reads: { n: number }): Database {
  return {
    selectFrom() {
      return {
        select() {
          return {
            where() {
              return {
                executeTakeFirst: () => {
                  reads.n += 1;
                  return Promise.resolve(row);
                },
              };
            },
          };
        },
      };
    },
  } as unknown as Database;
}

describe("metrics bearer", () => {
  const ring = keyRing(randomBytes(32));
  const token = "m".repeat(40);
  const sealed = encryptSecret(JSON.stringify({ token }), ring, "notify");
  const row = {
    enabled: true,
    secretsCiphertext: sealed.ciphertext,
    secretsNonce: sealed.nonce,
  };

  it("uses the environment token and does not read a saved one", async () => {
    const reads = { n: 0 };
    const env = {
      METRICS_TOKEN: token,
      AUTH_ENCRYPTION_KEY: ring,
    } as Env;
    clearMetricsBearer();
    await expect(metricsBearer(database(row, reads), env)).resolves.toBe(token);
    expect(reads.n).toBe(0);
  });

  it("opens the saved token, then remembers it for a few seconds", async () => {
    const reads = { n: 0 };
    const env = { AUTH_ENCRYPTION_KEY: ring } as Env;
    const db = database(row, reads);
    clearMetricsBearer();
    await expect(metricsBearer(db, env)).resolves.toBe(token);
    await expect(metricsBearer(db, env)).resolves.toBe(token);
    expect(reads.n).toBe(1);
  });

  it("stays closed when the row is disabled", async () => {
    const reads = { n: 0 };
    const env = { AUTH_ENCRYPTION_KEY: ring } as Env;
    clearMetricsBearer();
    await expect(
      metricsBearer(database({ ...row, enabled: false }, reads), env),
    ).resolves.toBeUndefined();
  });
});
