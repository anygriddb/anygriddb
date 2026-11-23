/**
 * What Administration answers about a source that is not there, against a
 * real database.
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keyRing } from "../auth/key-ring.js";
import type { Env } from "../env.js";
import { createTestDatabase } from "../test-database.js";
import {
  browserFactory,
  enrollTotp,
  errorCode as code,
} from "./caller.test-helpers.js";

const suffix = randomBytes(6).toString("hex");

describe("a source that is not there", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  const env = {
    AUTH_ENCRYPTION_KEY: keyRing(randomBytes(32)),
    PUBLIC_URL: "https://grid.example.org",
  } as unknown as Env;
  const hub = {
    closeUser: () => 0,
    closeAllBut: () => 0,
    closeSession: () => 0,
  };
  const admin = browserFactory({ db: () => db, env, hub })();

  beforeAll(async () => {
    const created = await createTestDatabase("unknown_source");
    db = created.db;
    close = created.close;
    await admin.signUpFirst({
      email: `admin-${suffix}@example.org`,
      displayName: "Ada Admin",
      password: "correct horse battery staple",
    });
    await enrollTotp(admin);
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  it("is said unknown every time its tables are asked", async () => {
    // Three reads ran side by side and two of them failed on it: the first
    // to fail chose between a refusal and a fault of the server.
    const answers = new Set<string>();
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const id = randomUUID();
      answers.add(await code(admin.call().admin.sources.tables({ id })));
      answers.add(await code(admin.call().admin.sources.tableListing({ id })));
    }
    expect([...answers]).toEqual(["unknown_source"]);
  });
});
