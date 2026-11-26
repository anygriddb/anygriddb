/**
 * What an API token reaches, through the real router on a migrated
 * database: a read-only token changes nothing, a token limited to some bases
 * stays in them, and no token opens a way in that outlives it.
 */
import { randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { keyRing } from "../auth/key-ring.js";
import { createSession, SESSION_COOKIE } from "../auth/session.js";
import { createApiToken } from "../auth/tokens.js";
import { loadEngine } from "../data/engine.js";
import { insertBase, insertTable } from "../data/schema-ops.js";
import { createInvitation } from "../data/sharing.js";
import { createView } from "../data/views.js";
import type { Env } from "../env.js";
import { jobReadableBy } from "../jobs.js";
import { writeSettings } from "../settings.js";
import { createTestDatabase } from "../test-database.js";
import { browserFactory, errorCode } from "./caller.test-helpers.js";

const suffix = randomBytes(6).toString("hex");

describe("what a token reaches", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  const env = {
    AUTH_ENCRYPTION_KEY: keyRing(randomBytes(32)),
    PUBLIC_URL: "https://grid.example.org",
  } as unknown as Env;
  const hub = {
    closeUser: vi.fn(() => 0),
    closeAllBut: vi.fn(() => 0),
    closeSession: vi.fn(() => 0),
  };
  const browser = browserFactory({ db: () => db, env, hub });
  const page = browser();
  const email = `ada-${suffix}@example.org`;
  let ada = "";
  let other = "";
  let baseA = "";
  let baseB = "";
  let tableA = "";
  let viewA = "";
  let jobA = "";
  let jobB = "";
  let accountJob = "";

  const as = (token: string) => page.call({ authorization: `Bearer ${token}` });
  const token = async (scope: { baseIds?: string[]; readOnly?: boolean }) =>
    (
      await createApiToken(db, ada, `t-${randomBytes(3).toString("hex")}`, {
        days: 1,
        ...scope,
      })
    ).token;
  const job = async (
    baseId: string | null,
    kind: "export" | "account_export",
  ) =>
    (
      await db
        .insertInto("jobs")
        .values({ kind, userId: ada, baseId, status: "queued", input: {} })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;

  beforeAll(async () => {
    const created = await createTestDatabase("token_reach");
    db = created.db;
    close = created.close;
    [ada, other] = (
      await db
        .insertInto("users")
        .values([
          { email, displayName: "Ada" },
          { email: `other-${suffix}@example.org`, displayName: "Other" },
        ])
        .returning("id")
        .execute()
    ).map((row) => row.id) as [string, string];
    await writeSettings(db, other, { mfaScope: "admins" });
    baseA = (await insertBase(db, ada, { name: "A" })).id;
    baseB = (await insertBase(db, ada, { name: "B" })).id;
    tableA = (
      await insertTable(db, ada, {
        baseId: baseA,
        name: "Items",
        columns: [
          { name: "title", label: "Title", fieldType: "text" },
          { name: "day", label: "Day", fieldType: "date" },
        ],
      })
    ).id;
    const { engine } = await loadEngine(db, tableA, () => true);
    viewA = (
      await createView(db, engine, ada, {
        tableId: tableA,
        name: "Mine",
        viewType: "calendar",
        config: { startColumn: "day" },
        ownerId: ada,
      })
    ).id;
    jobA = await job(baseA, "export");
    jobB = await job(baseB, "export");
    accountJob = await job(null, "account_export");
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  async function invitation(): Promise<{
    baseId: string;
    id: string;
    link: string;
  }> {
    const baseId = (await insertBase(db, other, { name: "Invited" })).id;
    const { token: link } = await createInvitation(db, {
      baseId,
      email,
      role: "editor",
      invitedBy: other,
    });
    const row = await db
      .selectFrom("invitations")
      .select("id")
      .where("baseId", "=", baseId)
      .executeTakeFirstOrThrow();
    return { baseId, id: row.id, link };
  }

  const memberOf = async (baseId: string) =>
    (await db
      .selectFrom("attributions")
      .select("role")
      .where("userId", "=", ada)
      .where("scope", "=", "base")
      .where("scopeId", "=", baseId)
      .executeTakeFirst()) !== undefined;

  it("a read-only token reads, and changes nothing of its account", async () => {
    const reader = as(await token({ baseIds: [baseA], readOnly: true }));
    expect(
      await errorCode(reader.rows.read({ tableId: tableA, limit: 1 })),
    ).toBe("ok");
    for (const call of [
      reader.catalog.createView({
        tableId: tableA,
        name: "by token",
        viewType: "grid",
        personal: true,
      }),
      reader.catalog.updateView({ viewId: viewA, name: "renamed" }),
      reader.catalog.duplicateView({ viewId: viewA }),
      reader.catalog.deleteView({ viewId: viewA }),
      reader.notifications.setPreference({
        event: "mention",
        channels: ["in_app", "email_immediate"],
      }),
      reader.notifications.markRead({}),
      reader.shortcuts.touchTable({ tableId: tableA }),
      reader.jobs.cancel({ jobId: jobA }),
      reader.jobs.retry({ jobId: jobA }),
    ]) {
      expect(await errorCode(call)).toBe("access_denied");
    }
    const view = await db
      .selectFrom("views")
      .select(["name", "deletedAt"])
      .where("id", "=", viewA)
      .executeTakeFirstOrThrow();
    expect(view).toEqual({ name: "Mine", deletedAt: null });
  });

  it("no token answers an invitation or sees them, whatever its scope", async () => {
    for (const scope of [{}, { baseIds: [baseA] }, { readOnly: true }]) {
      const bearer = as(await token(scope));
      const invited = await invitation();
      expect(await errorCode(bearer.auth.pendingInvitations())).toBe(
        "access_denied",
      );
      expect(
        await errorCode(
          bearer.auth.answerInvitation({
            invitationId: invited.id,
            accept: true,
          }),
        ),
      ).toBe("access_denied");
      expect(
        await errorCode(bearer.auth.acceptInvitation({ token: invited.link })),
      ).toBe("access_denied");
      expect(await memberOf(invited.baseId)).toBe(false);
    }
  });

  it("the account's session still answers its invitations", async () => {
    const invited = await invitation();
    const signedIn = browser();
    signedIn.jar[SESSION_COOKIE] = (await createSession(db, ada)).token;
    expect(
      await signedIn
        .call()
        .auth.answerInvitation({ invitationId: invited.id, accept: true }),
    ).toEqual({ baseId: invited.baseId });
    expect(await memberOf(invited.baseId)).toBe(true);
  });

  it("no token makes a calendar address, which would outlive it", async () => {
    for (const scope of [{}, { baseIds: [baseA] }, { readOnly: true }]) {
      const bearer = as(await token(scope));
      expect(
        await errorCode(bearer.catalog.renewCalendarFeed({ viewId: viewA })),
      ).toBe("access_denied");
      expect(
        await errorCode(bearer.catalog.revokeCalendarFeed({ viewId: viewA })),
      ).toBe("access_denied");
    }
  });

  it("a token limited to a base sees the jobs of that base alone", async () => {
    const limited = as(await token({ baseIds: [baseA] }));
    const { jobs } = await limited.jobs.list({ limit: 50 });
    expect(jobs.map((row) => row.id)).toEqual([jobA]);
    expect(await errorCode(limited.jobs.get({ jobId: jobA }))).toBe("ok");
    for (const id of [jobB, accountJob]) {
      expect(await errorCode(limited.jobs.get({ jobId: id }))).toBe(
        "unknown_job",
      );
      expect(await errorCode(limited.jobs.cancel({ jobId: id }))).toBe(
        "unknown_job",
      );
      expect(await errorCode(limited.jobs.retry({ jobId: id }))).toBe(
        "unknown_job",
      );
    }
  });

  it("no token reaches a job of no base, an account's export", async () => {
    const whole = as(await token({}));
    const { jobs } = await whole.jobs.list({ limit: 50 });
    expect(jobs.map((row) => row.id).sort()).toEqual([jobA, jobB].sort());
    expect(await errorCode(whole.jobs.get({ jobId: accountJob }))).toBe(
      "unknown_job",
    );
  });

  it("a token limited to a base is kept off what lists the whole account", async () => {
    const limited = as(await token({ baseIds: [baseA] }));
    for (const call of [
      limited.notifications.list({}),
      limited.notifications.preferences(),
      limited.shortcuts.list(),
    ]) {
      expect(await errorCode(call)).toBe("access_denied");
    }
    const whole = as(await token({ readOnly: true }));
    expect(await errorCode(whole.notifications.list({}))).toBe("ok");
  });

  it("a job's file follows the rights of today", () => {
    const owner = [
      { role: "owner" as const, scope: "base" as const, scopeId: baseA },
    ];
    const viewer = [
      { role: "viewer" as const, scope: "base" as const, scopeId: baseA },
    ];
    const table = {
      kind: "export" as const,
      baseId: baseA,
      tableId: tableA,
      input: {},
    };
    const snapshot = {
      kind: "export_snapshot" as const,
      baseId: baseA,
      tableId: null,
      input: {},
    };
    const account = {
      kind: "account_export" as const,
      baseId: null,
      tableId: null,
      input: { userId: other },
    };
    const person = { id: ada, isAdmin: false };
    const admin = { id: ada, isAdmin: true };
    expect(jobReadableBy(table, person, viewer)).toBe(true);
    expect(jobReadableBy(table, person, [])).toBe(false);
    expect(jobReadableBy(snapshot, person, owner)).toBe(true);
    expect(jobReadableBy(snapshot, person, viewer)).toBe(false);
    expect(jobReadableBy(account, admin, [])).toBe(true);
    expect(jobReadableBy(account, person, [])).toBe(false);
    expect(
      jobReadableBy({ ...account, input: { userId: ada } }, person, []),
    ).toBe(true);
    expect(jobReadableBy({ ...table, baseId: null }, person, viewer)).toBe(
      false,
    );
  });

  describe("a job that makes a base, started again", () => {
    const failed = async (kind: "duplicate_base" | "restore_base") =>
      (
        await db
          .insertInto("jobs")
          .values({
            kind,
            userId: ada,
            baseId: baseA,
            status: "failed",
            input: {},
          })
          .returning("id")
          .executeTakeFirstOrThrow()
      ).id;
    const statusOf = async (id: string) =>
      (
        await db
          .selectFrom("jobs")
          .select("status")
          .where("id", "=", id)
          .executeTakeFirstOrThrow()
      ).status;
    const bases = async () =>
      Number(
        (
          await db
            .selectFrom("bases")
            .select((eb) => eb.fn.countAll<string>().as("value"))
            .executeTakeFirstOrThrow()
        ).value,
      );

    it("is refused to a token kept to some bases", async () => {
      const limited = as(await token({ baseIds: [baseA] }));
      for (const kind of ["duplicate_base", "restore_base"] as const) {
        const id = await failed(kind);
        const before = await bases();
        expect(await errorCode(limited.jobs.retry({ jobId: id }))).toBe(
          "access_denied",
        );
        expect(await statusOf(id)).toBe("failed");
        expect(await bases()).toBe(before);
        await db.deleteFrom("jobs").where("id", "=", id).execute();
      }
    });

    it("is taken from its author's session and from a whole token", async () => {
      const signedIn = browser();
      signedIn.jar[SESSION_COOKIE] = (await createSession(db, ada)).token;
      for (const caller of [signedIn.call(), as(await token({}))]) {
        const id = await failed("duplicate_base");
        expect(await errorCode(caller.jobs.retry({ jobId: id }))).toBe("ok");
        expect(await statusOf(id)).toBe("queued");
        await db.deleteFrom("jobs").where("id", "=", id).execute();
      }
    });

    it("leaves a token kept to a base free to restart what stays in it", async () => {
      const limited = as(await token({ baseIds: [baseA] }));
      const id = (
        await db
          .insertInto("jobs")
          .values({
            kind: "export",
            userId: ada,
            baseId: baseA,
            tableId: tableA,
            status: "failed",
            input: {},
          })
          .returning("id")
          .executeTakeFirstOrThrow()
      ).id;
      expect(await errorCode(limited.jobs.retry({ jobId: id }))).toBe("ok");
      await db.deleteFrom("jobs").where("id", "=", id).execute();
    });
  });

  it("no token lists the account's tokens, and its session does", async () => {
    for (const scope of [{}, { baseIds: [baseA] }, { readOnly: true }]) {
      expect(await errorCode(as(await token(scope)).auth.tokens())).toBe(
        "access_denied",
      );
    }
    const signedIn = browser();
    signedIn.jar[SESSION_COOKIE] = (await createSession(db, ada)).token;
    expect(await errorCode(signedIn.call().auth.tokens())).toBe("ok");
  });
});
