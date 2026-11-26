/**
 * Who asks comes first. A procedure that needs a session answers
 * "unauthenticated" to a caller without one, whatever it is asked about:
 * it does not look the object up first, which would tell a stranger
 * whether an id names anything, and would let a request with no session
 * reach the tables. Checked on every procedure of the router, not on a
 * list of them: each is called without a session, with an input of the
 * shape it takes, about ids nobody has.
 */
import { randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keyRing } from "../auth/key-ring.js";
import type { Env } from "../env.js";
import { createTestDatabase } from "../test-database.js";
import { browserFactory, errorCode as code } from "./caller.test-helpers.js";
import {
  ask,
  BY_HAND,
  OPEN_EXCEPTIONS,
  walkRouter,
} from "./router-walk.test-helpers.js";

/**
 * What answers someone who is not signed in, on purpose: what declares
 * one of the open exceptions (`access/declaration.ts`) — signing in and
 * up, what the sign-in page shows, an invitation's link, what a public
 * link opens, a mail's unsubscribe link.
 */
const PROCEDURES = walkRouter();
const OPEN: readonly string[] = PROCEDURES.filter(
  ({ declaration }) =>
    declaration.exception !== undefined &&
    OPEN_EXCEPTIONS.has(declaration.exception),
).map(({ path }) => path);

describe("who asks comes first", () => {
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
  const browser = browserFactory({ db: () => db, env, hub });

  beforeAll(async () => {
    const created = await createTestDatabase("whoasks");
    db = created.db;
    close = created.close;
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  it("knows every name it lets through", () => {
    const known = new Set(PROCEDURES.map((procedure) => procedure.path));
    expect(PROCEDURES.length).toBeGreaterThan(300);
    expect(OPEN.filter((path) => !known.has(path))).toEqual([]);
    expect(Object.keys(BY_HAND).filter((path) => !known.has(path))).toEqual([]);
  });

  it("tells a stranger that they are not signed in, and nothing of what they asked about", async () => {
    // An input the procedure refuses proves nothing: the walk must get in.
    const stranger = browser();
    const notReached: string[] = [];
    const told: Array<[string, string]> = [];
    for (const { path, input } of PROCEDURES) {
      if (OPEN.includes(path)) continue;
      const answer = await code(ask(stranger, path, input));
      if (answer === "BAD_REQUEST") notReached.push(path);
      else if (answer !== "UNAUTHORIZED") told.push([path, answer]);
    }
    expect(notReached).toEqual([]);
    expect(told).toEqual([]);
  }, 120_000);

  it("tells an account that has still to set up its second factor that, and nothing of what it asked about", async () => {
    // The first account administers the instance, and an administrator
    // needs a second factor whatever the policy says of the others.
    const page = browser();
    await page.signUpFirst({
      email: "first@example.org",
      displayName: "First Account",
      password: "correct horse battery staple",
    });
    const told: Array<[string, string]> = [];
    for (const { path, input } of PROCEDURES) {
      // What an account does about itself works before its second
      // factor: that is how one is set up.
      if (OPEN.includes(path) || /^(auth|session)\./.test(path)) continue;
      const answer = await code(ask(page, path, input));
      // A change of Administration asks for the proof before all else.
      if (answer === "mfa_enrollment_required") continue;
      if (answer === "step_up_required" && path.startsWith("admin.")) continue;
      told.push([path, answer]);
    }
    expect(told).toEqual([]);
  }, 120_000);
});
