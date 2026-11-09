/**
 * The instance controls of ADR 0042, through the real tRPC router on a
 * migrated database: the sign-in trail, maintenance, a required second
 * factor, what an administrator does to an account, the trail's retention,
 * and erasure.
 */
import { randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { csvField } from "./admin-control.js";
import { requestActor } from "./auth/access.js";
import { purgeAuthEvents } from "./auth/auth-events.js";
import { SESSION_COOKIE } from "./auth/session.js";
import { createApiToken } from "./auth/tokens.js";
import { createInvitation } from "./data/sharing.js";
import { insertBase } from "./data/schema-ops.js";
import type { Env } from "./env.js";
import { createTestDatabase } from "./test-database.js";
import {
  browserFactory,
  enrollTotp,
  errorCode,
  TEST_IP as IP,
} from "./trpc/caller.test-helpers.js";

const suffix = randomBytes(6).toString("hex");
const PASSWORD = "correct horse battery staple";

describe("instance controls", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  const hub = { closeUser: vi.fn(() => 0), closeAllBut: vi.fn(() => 0) };
  const env = {
    AUTH_ENCRYPTION_KEY: randomBytes(32),
    PUBLIC_URL: "https://grid.example.org",
  } as unknown as Env;

  const browser = browserFactory({ db: () => db, env, hub });
  const code = errorCode;

  async function events(userId?: string) {
    return db
      .selectFrom("authEvents")
      .selectAll()
      .$if(userId !== undefined, (q) => q.where("userId", "=", userId ?? ""))
      .orderBy("occurredAt")
      .orderBy("id")
      .execute();
  }

  const admin = browser();
  const member = browser();
  let adminId = "";
  let memberId = "";
  const memberEmail = `member-${suffix}@example.org`;

  beforeAll(async () => {
    const created = await createTestDatabase("control");
    db = created.db;
    close = created.close;
    // The first account administers the instance.
    await admin.call().auth.signup({
      email: `admin-${suffix}@example.org`,
      displayName: "Ada Admin",
      password: PASSWORD,
    });
    // Administration asks for a second factor (ADR 0043).
    await enrollTotp(admin);
    await member.call().auth.signup({
      email: memberEmail,
      displayName: "Max Member",
      password: PASSWORD,
    });
    const users = await db
      .selectFrom("users")
      .select(["id", "isAdmin"])
      .execute();
    adminId = users.find((user) => user.isAdmin)?.id ?? "";
    memberId = users.find((user) => !user.isAdmin)?.id ?? "";
    // A name a spreadsheet would run as a formula, as an identity provider
    // may send one (sign-up refuses it).
    await db
      .updateTable("users")
      .set({ displayName: "=HYPERLINK(1)" })
      .where("id", "=", memberId)
      .execute();
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  it("keeps sign-ins, failures, and sign-outs, with the address", async () => {
    const someone = browser();
    expect(
      await code(
        someone.call().auth.login({ email: memberEmail, password: "wrong" }),
      ),
    ).toBe("invalid_credentials");
    await someone.call().auth.login({ email: memberEmail, password: PASSWORD });
    await someone.call().auth.logout();
    const trail = await events(memberId);
    expect(
      trail.map((event) => [event.action, event.method, event.detail]),
    ).toEqual([
      ["login_success", "signup", null],
      ["login_failure", "password", "invalid_credentials"],
      ["login_success", "password", null],
      ["logout", null, null],
    ]);
    expect(trail.every((event) => event.ip === IP)).toBe(true);
    expect(trail.every((event) => event.actorId === null)).toBe(true);
  });

  it("is append-only, but for events past their year", async () => {
    const [first] = await events(memberId);
    await expect(
      db
        .updateTable("authEvents")
        .set({ detail: "forged" })
        .where("id", "=", first?.id ?? "")
        .execute(),
    ).rejects.toThrow(/append-only/);
    await expect(
      db
        .deleteFrom("authEvents")
        .where("id", "=", first?.id ?? "")
        .execute(),
    ).rejects.toThrow(/append-only/);
    await db
      .insertInto("authEvents")
      .values({
        action: "login_success",
        userId: memberId,
        occurredAt: sql<Date>`now() - interval '400 days'`,
      })
      .execute();
    expect(await purgeAuthEvents(db, 365)).toBe(1);
    expect(await purgeAuthEvents(db, 365)).toBe(0);
  });

  it("lets only administrators in during maintenance", async () => {
    const memberToken = (await createApiToken(db, memberId, "script")).token;
    await member.call().auth.login({ email: memberEmail, password: PASSWORD });
    expect(member.jar[SESSION_COOKIE]).toBeTruthy();

    await admin.call().admin.updateSettings({ maintenance: true });
    // The member's session ended, and their sockets were told.
    expect(hub.closeUser).toHaveBeenCalledWith(memberId);
    expect(await code(member.call().catalog.list())).toBe("UNAUTHORIZED");
    expect(
      await code(
        member.call().auth.login({ email: memberEmail, password: PASSWORD }),
      ),
    ).toBe("instance_maintenance");
    // A token works no more than a session.
    expect(
      await code(
        member.call({ authorization: `Bearer ${memberToken}` }).catalog.list(),
      ),
    ).toBe("instance_maintenance");
    expect(
      await code(
        requestActor(db, { authorization: `Bearer ${memberToken}` }, undefined),
      ),
    ).toBe("instance_maintenance");
    // The administrator works on.
    expect(await code(admin.call().catalog.list())).toBe("ok");
    const swept = (await events()).filter(
      (event) =>
        event.action === "session_revoked" && event.detail === "maintenance",
    );
    expect(swept).toHaveLength(1);
    expect(swept[0]?.actorId).toBe(adminId);
    const refused = (await events(memberId)).at(-1);
    expect([refused?.action, refused?.detail]).toEqual([
      "login_failure",
      "instance_maintenance",
    ]);

    await admin.call().admin.updateSettings({ maintenance: false });
    await member.call().auth.login({ email: memberEmail, password: PASSWORD });
    expect(await code(member.call().catalog.list())).toBe("ok");
  });

  it("can require a second factor of every account", async () => {
    const token = (await createApiToken(db, memberId, "required")).token;
    const asMember = () =>
      requestActor(db, { authorization: `Bearer ${token}` }, undefined);
    expect(await code(asMember())).toBe("ok");
    await admin.call().admin.updateSettings({ mfaScope: "everyone" });
    expect(await code(asMember())).toBe("mfa_enrollment_required");
    await admin.call().admin.updateSettings({ mfaScope: "owners" });
    expect(await code(asMember())).toBe("ok");
  });

  it("keeps a setting written as text", async () => {
    await admin.call().admin.updateSettings({
      signup: "invite",
      defaultLocale: "fr",
    });
    expect(await member.call().auth.instance()).toMatchObject({
      signup: "invite",
      defaultLocale: "fr",
    });
    await admin.call().admin.updateSettings({
      signup: "open",
      defaultLocale: "en",
    });
  });

  it("shows and clears the banner", async () => {
    await admin.call().admin.updateSettings({ banner: "  Upgrade at 18:00  " });
    expect((await member.call().auth.instance()).banner).toBe(
      "Upgrade at 18:00",
    );
    await admin.call().admin.updateSettings({ banner: null });
    expect((await member.call().auth.instance()).banner).toBeNull();
  });

  it("acts on an account, and names the administrator who did", async () => {
    await member.call().auth.login({ email: memberEmail, password: PASSWORD });
    const sessions = await admin.call().admin.sessions();
    const theirs = sessions.sessions.find((s) => s.userId === memberId);
    expect(theirs?.mine).toBe(false);
    expect(sessions.sessions.some((s) => s.mine)).toBe(true);
    await admin.call().admin.endSession({ sessionId: theirs?.id ?? "" });
    expect(await code(member.call().catalog.list())).toBe("UNAUTHORIZED");

    await createApiToken(db, memberId, "leaked");
    expect(
      (await admin.call().admin.revokeTokens({ userId: memberId })).count,
    ).toBeGreaterThan(0);
    expect(
      await code(admin.call().admin.clearFactors({ userId: adminId })),
    ).toBe("invalid_account");
    await admin.call().admin.clearFactors({ userId: memberId });
    expect(
      await code(admin.call().admin.endUserSessions({ userId: adminId })),
    ).toBe("invalid_account");

    const page = await admin.call().admin.authAudit({ userId: memberId });
    const byAdmin = page.events.filter((event) => event.actorId === adminId);
    expect(byAdmin.map((event) => event.action).sort()).toEqual([
      "factors_cleared",
      "session_revoked",
      "tokens_revoked",
    ]);
    expect(byAdmin.every((event) => event.actorName === "Ada Admin")).toBe(
      true,
    );
    expect(page.retentionDays).toBe(365);
  });

  it("exports the trail and access as CSV a spreadsheet cannot run", async () => {
    const trail = await admin
      .call()
      .admin.exportAuthAudit({ userId: memberId });
    expect(trail.csv.startsWith("﻿occurredAt,action,method")).toBe(true);
    expect(trail.csv).toContain(IP);
    const access = await admin.call().admin.accessReport();
    const line = access.csv
      .split("\r\n")
      .find((row) => row.startsWith(memberEmail));
    expect(line).toContain("'=HYPERLINK(1)");
    // The last sign-in comes from the trail.
    expect(line).toMatch(/,\d{4}-\d{2}-\d{2}T[^,]+$/);
    expect(csvField('a "quote", here')).toBe('"a ""quote"", here"');
    expect(csvField("-1")).toBe("'-1");
  });

  it("keeps one live invitation per base and address", async () => {
    const base = await insertBase(db, adminId, { name: "Sales" });
    for (const role of ["viewer", "editor"] as const) {
      await createInvitation(db, {
        baseId: base.id,
        email: "Guest@Example.org",
        role,
        invitedBy: adminId,
      });
    }
    const pending = await admin.call().admin.invitations();
    const theirs = pending.invitations.filter(
      (invitation) => invitation.email === "guest@example.org",
    );
    expect(theirs.map((invitation) => invitation.role)).toEqual(["editor"]);
    await admin
      .call()
      .admin.withdrawInvitation({ invitationId: theirs[0]?.id ?? "" });
    expect((await admin.call().admin.invitations()).invitations).toHaveLength(
      0,
    );
  });

  it("forgets who and where when the account is erased", async () => {
    await member.call().auth.login({ email: memberEmail, password: PASSWORD });
    const before = await events(memberId);
    expect(before.length).toBeGreaterThan(0);
    await member.call().auth.erase({ password: PASSWORD });
    const ids = before.map((event) => event.id);
    const after = await db
      .selectFrom("authEvents")
      .selectAll()
      .where("id", "in", ids)
      .execute();
    expect(after).toHaveLength(before.length);
    expect(after.every((event) => event.userId === null)).toBe(true);
    expect(after.every((event) => event.ip === null)).toBe(true);
  });
});
