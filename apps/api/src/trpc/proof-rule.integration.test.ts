/**
 * The proof Administration asks for (ROADMAP #28): checked on every
 * procedure of the router, not on a list of them. A change asks for the
 * password or the second factor again unless `NO_PROOF` names it; a read
 * never does.
 */
import { randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keyRing } from "../auth/key-ring.js";
import type { Env } from "../env.js";
import { createTestDatabase } from "../test-database.js";
import { adminRouter } from "./admin-router.js";
import {
  browserFactory,
  enrollTotp,
  errorCode as code,
  signUpProved,
} from "./caller.test-helpers.js";
import { NO_PROOF } from "./proof-rule.js";

const suffix = randomBytes(6).toString("hex");
const PASSWORD = "correct horse battery staple";

/** Every procedure of Administration: its path, and whether it changes. */
const PROCEDURES = Object.entries(
  adminRouter._def.procedures as unknown as Record<
    string,
    { _def: { type: "query" | "mutation" | "subscription" } }
  >,
).map(([path, procedure]) => ({
  path: `admin.${path}`,
  type: procedure._def.type,
}));
const CHANGES = PROCEDURES.filter((procedure) => procedure.type === "mutation");

describe("the proof Administration asks for", () => {
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
  const admin = browser();
  const member = browser();
  const at = (name: string) => `${name}-${suffix}@example.org`;

  /** Calls a procedure by its path, with no input at all. */
  const bare = (page: ReturnType<typeof browser>, path: string) => {
    let target: unknown = page.call();
    for (const step of path.split(".")) {
      target = (target as Record<string, unknown>)[step];
    }
    return (target as (input?: unknown) => Promise<unknown>)(undefined);
  };

  beforeAll(async () => {
    const created = await createTestDatabase("proof");
    db = created.db;
    close = created.close;
    await admin.call().auth.signup({
      email: at("admin"),
      displayName: "Ada Admin",
      password: PASSWORD,
    });
    await enrollTotp(admin);
    await signUpProved(member, db, {
      email: at("member"),
      displayName: "Mel Member",
      password: PASSWORD,
    });
    await enrollTotp(member);
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  it("names only changes that exist", () => {
    const changes = new Set(CHANGES.map((procedure) => procedure.path));
    expect([...NO_PROOF].filter((path) => !changes.has(path))).toEqual([]);
    // Enough changes for the walk below to mean something.
    expect(CHANGES.length).toBeGreaterThan(50);
  });

  it("tells a member that Administration is closed, not to prove anything", async () => {
    for (const path of [
      "admin.updateSettings",
      "admin.setAdmin",
      "admin.sources.create",
      "admin.groups.addMember",
    ]) {
      expect([path, await code(bare(member, path))]).not.toEqual([
        path,
        "step_up_required",
      ]);
    }
    expect(
      await code(member.call().admin.updateSettings({ banner: "Mine now." })),
    ).toBe("access_denied");
  });

  // The walk below runs the changes that ask nothing, and one of them ends
  // everyone else's sessions: the member's checks come first.
  it("asks before every change it does not name, before its input is read", async () => {
    const asked: string[] = [];
    for (const { path } of CHANGES) {
      if ((await code(bare(admin, path))) === "step_up_required") {
        asked.push(path);
      }
    }
    expect(asked.sort()).toEqual(
      CHANGES.map((procedure) => procedure.path)
        .filter((path) => !NO_PROOF.has(path))
        .sort(),
    );
  });

  it("asks nothing before a read", async () => {
    for (const { path, type } of PROCEDURES) {
      if (type !== "query") continue;
      expect([path, await code(bare(admin, path))]).not.toEqual([
        path,
        "step_up_required",
      ]);
    }
  });

  it("lets a change through once the proof is given, for five minutes", async () => {
    const change = () =>
      admin.call().admin.updateSettings({ banner: "Back at six." });
    expect(await code(change())).toBe("step_up_required");
    await admin.call().admin.stepUp({ password: PASSWORD });
    expect(await code(change())).toBe("ok");
    // The proof grows old: the same change asks again.
    await db
      .updateTable("sessions")
      .set({ steppedUpAt: new Date(Date.now() - 6 * 60_000) })
      .execute();
    expect(await code(change())).toBe("step_up_required");
  });
});
