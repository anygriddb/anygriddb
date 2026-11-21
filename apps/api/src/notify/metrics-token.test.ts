import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
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

  const down = {
    selectFrom: () => ({
      select: () => ({
        where: () => ({
          executeTakeFirst: () => Promise.reject(new Error("down")),
        }),
      }),
    }),
  } as unknown as Database;

  it("keeps the token it last read while the database is down", async () => {
    const env = { AUTH_ENCRYPTION_KEY: ring } as Env;
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      clearMetricsBearer();
      await metricsBearer(database(row, { n: 0 }), env);
      vi.advanceTimersByTime(6_000);
      await expect(metricsBearer(down, env)).resolves.toBe(token);
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens nothing when the database is down and no token was read", async () => {
    clearMetricsBearer();
    await expect(
      metricsBearer(down, { AUTH_ENCRYPTION_KEY: ring } as Env),
    ).resolves.toBeUndefined();
  });

  it("does not ask a database that is down on every request", async () => {
    const env = { AUTH_ENCRYPTION_KEY: ring } as Env;
    let reads = 0;
    const failing = {
      selectFrom: () => ({
        select: () => ({
          where: () => ({
            executeTakeFirst: () => {
              reads += 1;
              return Promise.reject(new Error("down"));
            },
          }),
        }),
      }),
    } as unknown as Database;
    clearMetricsBearer();
    for (let request = 0; request < 5; request += 1) {
      await metricsBearer(failing, env);
    }
    expect(reads).toBe(1);
  });

  it("forgets a read in flight once the token is changed", async () => {
    const env = { AUTH_ENCRYPTION_KEY: ring } as Env;
    const hanging = {
      selectFrom: () => ({
        select: () => ({
          where: () => ({
            executeTakeFirst: () => new Promise(() => undefined),
          }),
        }),
      }),
    } as unknown as Database;
    vi.useFakeTimers();
    try {
      clearMetricsBearer();
      const first = metricsBearer(hanging, env);
      await vi.advanceTimersByTimeAsync(2_000);
      await first;
      clearMetricsBearer();
      await expect(
        metricsBearer(database({ ...row, enabled: false }, { n: 0 }), env),
      ).resolves.toBeUndefined();
      clearMetricsBearer();
      await expect(metricsBearer(database(row, { n: 0 }), env)).resolves.toBe(
        token,
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
