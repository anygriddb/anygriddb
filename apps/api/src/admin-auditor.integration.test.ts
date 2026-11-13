/**
 * The auditor (ROADMAP #34, ADR 0071): an account that reads every page
 * of Administration and changes nothing. The rule is checked on every
 * procedure of the router, not on a list of them.
 */
import { randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keyRing } from "./auth/key-ring.js";
import { insertBase } from "./data/schema-ops.js";
import type { Env } from "./env.js";
import { createTestDatabase } from "./test-database.js";
import { adminRouter } from "./trpc/admin-router.js";
import {
  AUDITOR_EXPORTS,
  AUDITOR_KEPT_OUT,
  auditorMayCall,
} from "./trpc/auditor-rule.js";
import {
  browserFactory,
  enrollTotp,
  errorCode as code,
  signUpProved,
} from "./trpc/caller.test-helpers.js";

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

describe("the auditor", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let adminId = "";
  let auditorId = "";
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
  const auditor = browser();
  const at = (name: string) => `${name}-${suffix}@example.org`;

  /** Calls a procedure by its path, with no input at all. */
  const bare = (page: ReturnType<typeof browser>, path: string) => {
    let target: unknown = page.call();
    for (const step of path.split(".")) {
      target = (target as Record<string, unknown>)[step];
    }
    return (target as (input?: unknown) => Promise<unknown>)(undefined);
  };
  const told = (detail: string) =>
    db
      .selectFrom("authEvents")
      .select(["actorId", "method"])
      .where("action", "=", "account_updated")
      .where("userId", "=", auditorId)
      .where("detail", "=", detail)
      .execute();

  beforeAll(async () => {
    const created = await createTestDatabase("auditor");
    db = created.db;
    close = created.close;
    await admin.call().auth.signup({
      email: at("admin"),
      displayName: "Ada Admin",
      password: PASSWORD,
    });
    await enrollTotp(admin);
    adminId = (
      await db
        .selectFrom("users")
        .select("id")
        .where("email", "=", at("admin"))
        .executeTakeFirstOrThrow()
    ).id;
    auditorId = await signUpProved(auditor, db, {
      email: at("auditor"),
      displayName: "Aud Itor",
      password: PASSWORD,
    });
    await enrollTotp(auditor);
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  it("is a role given with the proof, and written to the sign-in trail", async () => {
    // Before the role: Administration is closed, reads included.
    expect(await code(auditor.call().admin.users({}))).toBe("access_denied");
    expect(
      await code(
        admin.call().admin.setAuditor({ userId: auditorId, auditor: true }),
      ),
    ).toBe("step_up_required");
    await admin.call().admin.stepUp({ password: PASSWORD });
    await admin.call().admin.setAuditor({ userId: auditorId, auditor: true });
    await admin.call().admin.setAuditor({ userId: auditorId, auditor: true });
    expect(await told("auditor_granted")).toEqual([
      { actorId: adminId, method: "admin" },
    ]);
    expect((await auditor.call().session.current())?.isAuditor).toBe(true);
    expect(
      (await admin.call().admin.account({ userId: auditorId })).isAuditor,
    ).toBe(true);
    // The role is not theirs to give, nor to keep for themselves.
    expect(
      await code(
        auditor.call().admin.setAuditor({ userId: adminId, auditor: true }),
      ),
    ).toBe("access_denied");
  });

  it("reads Administration: accounts, bases, groups, sources, settings, trails", async () => {
    await insertBase(db, adminId, { name: `Ledger ${suffix}` });
    const page = auditor.call().admin;
    expect((await page.users({})).users.map((user) => user.email)).toEqual(
      expect.arrayContaining([at("admin"), at("auditor")]),
    );
    expect((await page.account({ userId: adminId })).email).toBe(at("admin"));
    expect(
      (await page.baseOverview.list({})).bases.map((base) => base.name),
    ).toContain(`Ledger ${suffix}`);
    expect((await page.groups.list()).groups).toEqual([]);
    expect(await page.sources.list()).toEqual([]);
    expect(await page.settings()).toMatchObject({ signup: expect.any(String) });
    expect((await page.audit({ limit: 5 })).events.length).toBeGreaterThan(0);
    expect((await page.authAudit({ limit: 5 })).events.length).toBeGreaterThan(
      0,
    );
    expect((await page.sessions()).sessions.length).toBeGreaterThan(0);
  });

  it("exports the trails and the access report, under its own name on the trail", async () => {
    const page = auditor.call().admin;
    expect((await page.exportAudit({})).csv).toContain("action");
    expect((await page.exportAuthAudit({})).csv).toContain("action");
    expect((await page.accessReport()).csv).toContain(at("auditor"));
    const exports = await db
      .selectFrom("auditEvents")
      .select("userId")
      .where("action", "=", "export")
      .execute();
    expect(exports).toHaveLength(3);
    expect(exports.every((event) => event.userId === auditorId)).toBe(true);
  });

  it("changes nothing: every procedure that is not a read refuses it before reading its input", async () => {
    const changes = PROCEDURES.filter(
      ({ type, path }) => !auditorMayCall(type, path),
    );
    // The rule leaves the auditor three mutations, and takes one read away.
    expect(
      PROCEDURES.filter(
        ({ type, path }) => type === "mutation" && auditorMayCall(type, path),
      )
        .map(({ path }) => path)
        .sort(),
    ).toEqual([...AUDITOR_EXPORTS].sort());
    expect(
      changes.filter(({ type }) => type === "query").map(({ path }) => path),
    ).toEqual([...AUDITOR_KEPT_OUT]);
    expect(changes.length).toBeGreaterThan(60);

    const before = await db
      .selectFrom("auditEvents")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .executeTakeFirstOrThrow();
    const answers: Record<string, string | null> = {};
    for (const { path } of changes) {
      answers[path] = await code(bare(auditor, path));
    }
    expect(
      Object.entries(answers).filter(
        ([, answer]) => answer !== "access_denied",
      ),
    ).toEqual([]);
    const after = await db
      .selectFrom("auditEvents")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .executeTakeFirstOrThrow();
    expect(after.count).toBe(before.count);
  });

  it("is let into every read: none answers that access is denied", async () => {
    const reads = PROCEDURES.filter(
      ({ type, path }) => type === "query" && auditorMayCall(type, path),
    );
    expect(reads.length).toBeGreaterThan(30);
    const refused: string[] = [];
    for (const { path } of reads) {
      // Without its input a read answers that the input is wrong, or
      // answers: either way the auditor was let in.
      if ((await code(bare(auditor, path))) === "access_denied") {
        refused.push(path);
      }
    }
    expect(refused).toEqual([]);
  });

  it("leaves everyone else where they were: a member reads nothing, an administrator still changes", async () => {
    const member = browser();
    await signUpProved(member, db, {
      email: at("member"),
      displayName: "Mem Ber",
      password: PASSWORD,
    });
    await enrollTotp(member);
    const refused: string[] = [];
    for (const { path } of PROCEDURES) {
      const answer = await code(bare(member, path));
      // Refused, or stopped on its missing input before anyone is asked
      // who calls: never an answer.
      if (answer !== "access_denied" && answer !== "BAD_REQUEST") {
        refused.push(`${path}: ${answer}`);
      }
    }
    expect(refused).toEqual([]);
    await admin.call().admin.updateSettings({ banner: "Still mine to set" });
    expect((await admin.call().admin.settings()).banner).toBe(
      "Still mine to set",
    );
  });

  it("ends when the role is taken away, which the trail tells too", async () => {
    await admin.call().admin.setAuditor({ userId: auditorId, auditor: false });
    expect(await told("auditor_revoked")).toEqual([
      { actorId: adminId, method: "admin" },
    ]);
    expect(await code(auditor.call().admin.users({}))).toBe("access_denied");
    expect(await code(auditor.call().admin.exportAudit({}))).toBe(
      "access_denied",
    );
  });
});
