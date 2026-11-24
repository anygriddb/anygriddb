import { randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { keyRing } from "../auth/key-ring.js";
import type { Env } from "../env.js";
import { createTestDatabase } from "../test-database.js";
import { browserFactory, enrollTotp } from "./caller.test-helpers.js";

/**
 * What a test of Administration's roles starts from: a database whose
 * first account is an administrator with a second factor who gave the
 * proof, browsers to sign others in, and addresses of the test's own.
 */
export function adminBench(name: string, password: string) {
  const suffix = randomBytes(6).toString("hex");
  const state: { db?: Database } = {};
  const env = {
    AUTH_ENCRYPTION_KEY: keyRing(randomBytes(32)),
    PUBLIC_URL: "https://grid.example.org",
  } as unknown as Env;
  const hub = {
    closeUser: () => 0,
    closeAllBut: () => 0,
    closeSession: () => 0,
  };
  const browser = browserFactory({
    db: () => {
      if (!state.db) throw new Error("the bench has not started");
      return state.db;
    },
    env,
    hub,
  });
  const account = (who: string) => ({
    email: `${who}-${suffix}@example.org`,
    displayName: who,
    password,
  });
  async function start() {
    const created = await createTestDatabase(name);
    state.db = created.db;
    const admin = browser();
    await admin.signUpFirst(account("admin"));
    await enrollTotp(admin);
    await admin.call().admin.stepUp({ password });
    const { id: adminId } = await created.db
      .selectFrom("users")
      .select("id")
      .where("email", "=", account("admin").email)
      .executeTakeFirstOrThrow();
    return { db: created.db, close: created.close, admin, adminId };
  }
  return { suffix, browser, account, start };
}
