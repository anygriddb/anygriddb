/**
 * Accounts in Administration (ROADMAP #67, #18, #19, #20; ADR 0057): a
 * person added with roles on any live base and no password until their
 * first link, the list filtered and sorted, an account's page, and pending
 * invitations sent again.
 */
import { randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withAudit } from "./data/audit-context.js";
import { ERASED_USER_ID } from "./data/erasure.js";
import { grantMember } from "./data/members.js";
import { insertBase } from "./data/schema-ops.js";
import { createInvitation } from "./data/sharing.js";
import type { Env } from "./env.js";
import { clearSmtpCache } from "./integrations/smtp.js";
import { fakeSmtp, mailText } from "./mail.test-helpers.js";
import { setGroupRole } from "./scim/groups.js";
import { createTestDatabase } from "./test-database.js";
import {
  browserFactory,
  enrollTotp,
  errorCode as code,
  signUpProved,
} from "./trpc/caller.test-helpers.js";

const suffix = randomBytes(6).toString("hex");
const PASSWORD = "correct horse battery staple";
const RESET = /\/reset\/([A-Za-z0-9_-]{43})/;
const DAY_MS = 86_400_000;

describe("accounts in Administration", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let smtp: Awaited<ReturnType<typeof fakeSmtp>>;
  let adminId = "";
  let n = 0;
  const env = {
    AUTH_ENCRYPTION_KEY: randomBytes(32),
    PUBLIC_URL: "https://grid.example.org",
    SMTP_FROM: "grid@example.org",
  } as unknown as Env & { SMTP_HOST?: string; SMTP_PORT?: number };
  const hub = {
    closeUser: () => 0,
    closeAllBut: () => 0,
    closeSession: () => 0,
  };
  const browser = browserFactory({ db: () => db, env, hub });
  const admin = browser();

  const mailOff = () => {
    const host = env.SMTP_HOST;
    delete env.SMTP_HOST;
    clearSmtpCache(db);
    return () => {
      env.SMTP_HOST = host;
      clearSmtpCache(db);
    };
  };
  const idOf = async (email: string) =>
    (
      await db
        .selectFrom("users")
        .select("id")
        .where("email", "=", email)
        .executeTakeFirst()
    )?.id;
  /** A member's account, signed in on its own browser. */
  const member = async (name: string) => {
    n += 1;
    const email = `${name.toLowerCase()}-${String(n)}-${suffix}@example.org`;
    const page = browser();
    const id = await signUpProved(page, db, {
      email,
      displayName: name,
      password: PASSWORD,
    });
    return { email, id, page };
  };

  beforeAll(async () => {
    const created = await createTestDatabase("accounts");
    db = created.db;
    close = created.close;
    smtp = await fakeSmtp();
    env.SMTP_HOST = "127.0.0.1";
    env.SMTP_PORT = smtp.port;
    await admin.call().auth.signup({
      email: `admin-${suffix}@example.org`,
      displayName: "Ada Admin",
      password: PASSWORD,
    });
    await enrollTotp(admin);
    adminId = (await idOf(`admin-${suffix}@example.org`)) ?? "";
  }, 120_000);

  afterAll(async () => {
    await smtp.close();
    await close?.();
  });

  describe("adding a person", () => {
    it("makes an account with no password, whose first link sets one, once", async () => {
      await admin.call().admin.updateSettings({ signup: "closed" });
      try {
        const email = `added-${suffix}@example.org`;
        expect(
          await admin.call().admin.createAccount({
            email: email.toUpperCase(),
            displayName: "Added Person",
          }),
        ).toEqual({ userId: expect.any(String), sent: true, to: email });
        const id = (await idOf(email)) ?? "";
        expect(
          await db
            .selectFrom("passwordHashes")
            .select("userId")
            .where("userId", "=", id)
            .executeTakeFirst(),
        ).toBeUndefined();
        const welcome = mailText(await smtp.next(email));
        expect(welcome).toContain("Ada Admin created an AnyGridDB account");
        const token = RESET.exec(welcome)?.[1] ?? "";
        const link = await db
          .selectFrom("passwordResets")
          .select("expiresAt")
          .where("userId", "=", id)
          .executeTakeFirstOrThrow();
        // A week to use it.
        expect(link.expiresAt.getTime() - Date.now()).toBeGreaterThan(
          6 * DAY_MS,
        );
        // Nothing signs in before the link is used.
        expect(
          await code(
            browser().call().auth.login({ email, password: PASSWORD }),
          ),
        ).toBe("invalid_credentials");
        await browser()
          .call()
          .auth.resetPassword({ token, password: PASSWORD });
        const person = browser();
        expect(
          await person.call().auth.login({ email, password: PASSWORD }),
        ).toMatchObject({ status: "session" });
        expect(
          await code(
            browser()
              .call()
              .auth.resetPassword({ token, password: "another long one" }),
          ),
        ).toBe("invalid_reset_link");
        // The trail says who created it.
        expect(
          await db
            .selectFrom("authEvents")
            .select(["actorId", "method", "detail"])
            .where("action", "=", "account_created")
            .where("userId", "=", id)
            .execute(),
        ).toEqual([{ actorId: adminId, method: "admin", detail: null }]);
      } finally {
        await admin.call().admin.updateSettings({ signup: "open" });
      }
    });

    it("hands the link over without email, and refuses an address taken", async () => {
      const restore = mailOff();
      try {
        const email = `handed-${suffix}@example.org`;
        const handed = await admin.call().admin.createAccount({
          email,
          displayName: "Handed",
          admin: true,
        });
        expect(handed.sent).toBe(false);
        if (handed.sent) return;
        expect(handed.link).toMatch(RESET);
        expect(
          new Date(handed.expiresAt).getTime() - Date.now(),
        ).toBeGreaterThan(6 * DAY_MS);
        expect(
          await code(
            admin.call().admin.createAccount({ email, displayName: "Again" }),
          ),
        ).toBe("account_already_exists");
        expect(
          await db
            .selectFrom("authEvents")
            .select("detail")
            .where("action", "=", "account_created")
            .where("userId", "=", (await idOf(email)) ?? "")
            .executeTakeFirst(),
        ).toEqual({ detail: "as_admin" });
      } finally {
        restore();
      }
    });

    it("gives roles on any live base, on the change trail, under the invitation domains", async () => {
      const owner = await member("Owner");
      const theirs = await insertBase(db, owner.id, {
        name: `Theirs ${suffix}`,
      });
      const mine = await insertBase(db, adminId, { name: `Mine ${suffix}` });
      const offered = (await admin.call().admin.bases.list({})).bases.map(
        (base) => base.id,
      );
      expect(offered).toEqual(expect.arrayContaining([theirs.id, mine.id]));
      // Two bases of one name are told apart by their owners.
      expect(
        (await admin.call().admin.bases.list({ search: `Theirs ${suffix}` }))
          .bases,
      ).toEqual([
        { id: theirs.id, name: `Theirs ${suffix}`, owners: ["Owner"] },
      ]);

      const email = `joined-${suffix}@example.org`;
      await admin.call().admin.createAccount({
        email,
        displayName: "Joined",
        memberships: [
          { baseId: theirs.id, role: "editor" },
          { baseId: mine.id, role: "viewer" },
        ],
      });
      const id = (await idOf(email)) ?? "";
      const roles = await db
        .selectFrom("roleBindings")
        .select(["scopeId", "role"])
        .where("userId", "=", id)
        .where("scope", "=", "base")
        .orderBy("role")
        .execute();
      expect(roles).toEqual([
        { scopeId: theirs.id, role: "editor" },
        { scopeId: mine.id, role: "viewer" },
      ]);
      expect(
        await db
          .selectFrom("auditEvents")
          .select("userId")
          .where("action", "=", "catalog")
          .where(
            sql<boolean>`new_value ->> 'scope_id' = ${theirs.id} and new_value ->> 'user_id' = ${id}`,
          )
          .execute(),
      ).toEqual([{ userId: adminId }]);

      // A base in the trash: refused, and no account is made.
      await db
        .updateTable("bases")
        .set({ deletedAt: new Date() })
        .where("id", "=", theirs.id)
        .execute();
      const refused = `refused-${suffix}@example.org`;
      expect(
        await code(
          admin.call().admin.createAccount({
            email: refused,
            displayName: "Refused",
            memberships: [{ baseId: theirs.id, role: "viewer" }],
          }),
        ),
      ).toBe("not_found");
      expect(await idOf(refused)).toBeUndefined();
      expect(
        (await admin.call().admin.bases.list({})).bases.map((base) => base.id),
      ).not.toContain(theirs.id);

      await admin.call().admin.updateSettings({
        signupDomains: ["example.org"],
        invitations: "domains",
      });
      try {
        expect(
          await code(
            admin.call().admin.createAccount({
              email: `outside-${suffix}@elsewhere.test`,
              displayName: "Outside",
              memberships: [{ baseId: mine.id, role: "viewer" }],
            }),
          ),
        ).toBe("invitation_domain_not_allowed");
        // Without a base, the address is the administrator's to choose.
        expect(
          await code(
            admin.call().admin.createAccount({
              email: `outside-${suffix}@elsewhere.test`,
              displayName: "Outside",
            }),
          ),
        ).toBe("ok");
      } finally {
        await admin
          .call()
          .admin.updateSettings({ signupDomains: [], invitations: "anyone" });
      }
    });

    it("sends a new first link to a person who asks for one", async () => {
      await admin.call().admin.updateSettings({ passwordReset: "self" });
      const restore = mailOff();
      const email = `lost-${suffix}@example.org`;
      try {
        await admin
          .call()
          .admin.createAccount({ email, displayName: "Lost Link" });
      } finally {
        restore();
      }
      await browser().call().auth.requestPasswordReset({ email });
      expect(mailText(await smtp.next(email))).toMatch(RESET);
    });

    it("keeps an account that signs in through its provider without a link", async () => {
      const sso = await db
        .insertInto("users")
        .values({ email: `sso-${suffix}@example.org`, displayName: "Sso" })
        .returning("id")
        .executeTakeFirstOrThrow();
      await db
        .insertInto("ssoIdentities")
        .values({
          userId: sso.id,
          provider: "oidc",
          issuer: "https://id.example.org",
          subject: `sso-${suffix}`,
        })
        .execute();
      expect(
        await code(admin.call().admin.sendPasswordReset({ userId: sso.id })),
      ).toBe("sso_account");
    });
  });

  describe("the accounts list", () => {
    it("filters by status, administrator, second factor, and origin, and sorts", async () => {
      const stamp = `list-${suffix}`;
      const named = (label: string) => `${stamp}-${label}@example.org`;
      const make = (label: string, values: Record<string, unknown> = {}) =>
        db
          .insertInto("users")
          .values({ email: named(label), displayName: label, ...values })
          .returning("id")
          .executeTakeFirstOrThrow();
      await make("Alpha");
      await make("Bravo", { disabledAt: new Date() });
      await make("Charlie", { lockedAt: new Date() });
      await make("Delta", { scimUserName: `delta-${suffix}` });
      const echo = await make("Echo", { isAdmin: true });
      await db
        .insertInto("ssoIdentities")
        .values({
          userId: echo.id,
          provider: "saml",
          issuer: "https://id.example.org",
          subject: `echo-${suffix}`,
        })
        .execute();
      const list = async (filters: Record<string, unknown>) =>
        (
          await admin
            .call()
            .admin.users({ search: stamp, sort: "name", ...filters })
        ).users.map((user) => user.displayName);

      expect(await list({})).toEqual([
        "Alpha",
        "Bravo",
        "Charlie",
        "Delta",
        "Echo",
      ]);
      expect(await list({ direction: "desc" })).toEqual([
        "Echo",
        "Delta",
        "Charlie",
        "Bravo",
        "Alpha",
      ]);
      expect(await list({ status: "disabled" })).toEqual(["Bravo"]);
      expect(await list({ status: "locked" })).toEqual(["Charlie"]);
      expect(await list({ status: "active" })).not.toContain("Bravo");
      expect(await list({ admin: true })).toEqual(["Echo"]);
      expect(await list({ origin: "scim" })).toEqual(["Delta"]);
      expect(await list({ origin: "sso" })).toEqual(["Echo"]);
      expect(await list({ origin: "local" })).toEqual([
        "Alpha",
        "Bravo",
        "Charlie",
      ]);
      expect(await list({ mfa: true })).toEqual([]);
      expect(
        (await admin.call().admin.users({ search: "Ada Admin", mfa: true }))
          .users,
      ).toHaveLength(1);
      const page = await admin
        .call()
        .admin.users({ search: stamp, origin: "local", limit: 2 });
      expect(page.users).toHaveLength(2);
      expect(page.total).toBe(3);
    });
  });

  describe("an account's page", () => {
    it("shows identity, origin, bases with the group that gives them, and sign-ins", async () => {
      const person = await member("Paged");
      const direct = await insertBase(db, adminId, {
        name: `Direct ${suffix}`,
      });
      const viaGroup = await insertBase(db, adminId, {
        name: `Grouped ${suffix}`,
      });
      await grantMember(db, adminId, {
        baseId: direct.id,
        email: person.email,
        role: "editor",
      });
      const group = await withAudit(
        db,
        { userId: adminId, source: "scim" },
        async (tx) => {
          const made = await tx
            .insertInto("groups")
            .values({ displayName: `Team ${suffix}` })
            .returning("id")
            .executeTakeFirstOrThrow();
          await tx
            .insertInto("groupMembers")
            .values({ groupId: made.id, userId: person.id })
            .execute();
          return made;
        },
      );
      await setGroupRole(db, adminId, {
        baseId: viaGroup.id,
        groupId: group.id,
        role: "viewer",
      });

      const page = await admin.call().admin.account({ userId: person.id });
      expect(page).toMatchObject({
        id: person.id,
        email: person.email,
        origin: "local",
        hasPassword: true,
        disabledAt: null,
        identities: [],
      });
      expect(page.bases).toEqual([
        {
          id: direct.id,
          name: `Direct ${suffix}`,
          role: "editor",
          viaGroup: null,
        },
        {
          id: viaGroup.id,
          name: `Grouped ${suffix}`,
          role: "viewer",
          viaGroup: `Team ${suffix}`,
        },
      ]);
      expect(page.sessions.length).toBeGreaterThan(0);
      expect(page.signIns[0]).toMatchObject({ action: "login_success" });
      expect(JSON.stringify(page)).not.toMatch(/hash|token_hash|secret/i);

      expect(
        await code(admin.call().admin.account({ userId: ERASED_USER_ID })),
      ).toBe("invalid_account");
    });
  });

  describe("an account's bases (ROADMAP #68)", () => {
    it("gives, changes, and takes a role on any live base, each on the trail", async () => {
      const owner = await member("Keeper");
      const person = await member("Mover");
      const base = await insertBase(db, owner.id, { name: `Moved ${suffix}` });
      const roleOn = async () =>
        (await admin.call().admin.account({ userId: person.id })).bases.find(
          (row) => row.id === base.id,
        )?.role;

      // A base the administrator is not in.
      await admin.call().admin.setBaseRole({
        userId: person.id,
        baseId: base.id,
        role: "viewer",
      });
      expect(await roleOn()).toBe("viewer");
      await admin.call().admin.setBaseRole({
        userId: person.id,
        baseId: base.id,
        role: "editor",
      });
      expect(await roleOn()).toBe("editor");
      const trail = await db
        .selectFrom("auditEvents")
        .select("userId")
        .where("action", "=", "catalog")
        .where(
          sql<boolean>`new_value ->> 'scope_id' = ${base.id} and new_value ->> 'user_id' = ${person.id}`,
        )
        .execute();
      expect(trail).toEqual([{ userId: adminId }, { userId: adminId }]);

      await admin
        .call()
        .admin.removeBaseRole({ userId: person.id, baseId: base.id });
      expect(await roleOn()).toBeUndefined();
      // Taking a role away that was not there changes nothing.
      expect(
        await code(
          admin
            .call()
            .admin.removeBaseRole({ userId: person.id, baseId: base.id }),
        ),
      ).toBe("ok");
    });

    it("keeps an owner on every base", async () => {
      const owner = await member("Sole");
      const base = await insertBase(db, owner.id, { name: `Kept ${suffix}` });
      expect(
        await code(
          admin.call().admin.setBaseRole({
            userId: owner.id,
            baseId: base.id,
            role: "editor",
          }),
        ),
      ).toBe("invalid_owner");
      expect(
        await code(
          admin
            .call()
            .admin.removeBaseRole({ userId: owner.id, baseId: base.id }),
        ),
      ).toBe("invalid_owner");
      // With a second owner, the first may step down.
      const heir = await member("Heir");
      await admin
        .call()
        .admin.setBaseRole({ userId: heir.id, baseId: base.id, role: "owner" });
      await admin.call().admin.setBaseRole({
        userId: owner.id,
        baseId: base.id,
        role: "viewer",
      });
      const roles = await db
        .selectFrom("roleBindings")
        .select(["userId", "role"])
        .where("scope", "=", "base")
        .where("scopeId", "=", base.id)
        .orderBy("role")
        .execute();
      expect(roles).toEqual([
        { userId: heir.id, role: "owner" },
        { userId: owner.id, role: "viewer" },
      ]);
    });

    it("refuses a base in the trash, the erased account, an address outside the domains, and anyone but an administrator", async () => {
      const person = await member("Outsider");
      const base = await insertBase(db, adminId, { name: `Shut ${suffix}` });
      const trashed = await insertBase(db, adminId, {
        name: `Trashed ${suffix}`,
      });
      await db
        .updateTable("bases")
        .set({ deletedAt: new Date() })
        .where("id", "=", trashed.id)
        .execute();
      expect(
        await code(
          admin.call().admin.setBaseRole({
            userId: person.id,
            baseId: trashed.id,
            role: "viewer",
          }),
        ),
      ).toBe("not_found");
      expect(
        await code(
          admin.call().admin.setBaseRole({
            userId: ERASED_USER_ID,
            baseId: base.id,
            role: "viewer",
          }),
        ),
      ).toBe("invalid_account");

      await admin.call().admin.updateSettings({
        signupDomains: ["example.com"],
        invitations: "domains",
      });
      try {
        expect(
          await code(
            admin.call().admin.setBaseRole({
              userId: person.id,
              baseId: base.id,
              role: "viewer",
            }),
          ),
        ).toBe("invitation_domain_not_allowed");
      } finally {
        await admin
          .call()
          .admin.updateSettings({ signupDomains: [], invitations: "anyone" });
      }

      const someone = await member("Bystander");
      for (const call of [
        () =>
          someone.page.call().admin.setBaseRole({
            userId: person.id,
            baseId: base.id,
            role: "owner",
          }),
        () =>
          someone.page
            .call()
            .admin.removeBaseRole({ userId: person.id, baseId: base.id }),
      ]) {
        expect(await code(call())).toBe("access_denied");
      }
    });
  });

  describe("pending invitations", () => {
    it("sends one again with a new link, by mail or by hand, and withdraws it", async () => {
      const owner = await member("Inviter");
      const base = await insertBase(db, owner.id, {
        name: `Invited ${suffix}`,
      });
      const email = `guest-${suffix}@example.org`;
      const sent = await createInvitation(db, {
        baseId: base.id,
        email,
        role: "viewer",
        invitedBy: owner.id,
      });
      const { id } = await db
        .selectFrom("invitations")
        .select("id")
        .where("baseId", "=", base.id)
        .executeTakeFirstOrThrow();

      expect(
        await admin.call().admin.resendInvitation({ invitationId: id }),
      ).toEqual({ mailed: true, to: email });
      expect(mailText(await smtp.next(email))).toContain("Inviter invited you");
      expect(
        await code(browser().call().auth.invitation({ token: sent.token })),
      ).toBe("invalid_invitation");

      const restore = mailOff();
      try {
        const handed = await admin
          .call()
          .admin.resendInvitation({ invitationId: id });
        expect(handed.mailed).toBe(false);
        const token = handed.mailed
          ? ""
          : (handed.link.split("/invite/")[1] ?? "");
        expect((await browser().call().auth.invitation({ token })).email).toBe(
          email,
        );
      } finally {
        restore();
      }

      await admin.call().admin.withdrawInvitation({ invitationId: id });
      expect(
        await code(admin.call().admin.resendInvitation({ invitationId: id })),
      ).toBe("invalid_invitation");
    });
  });

  it("refuses everyone but an administrator", async () => {
    const someone = await member("Someone");
    const calls = [
      () =>
        someone.page.call().admin.createAccount({
          email: `nope-${suffix}@example.org`,
          displayName: "Nope",
        }),
      () => someone.page.call().admin.account({ userId: someone.id }),
      () => someone.page.call().admin.users({}),
      () => someone.page.call().admin.bases.list({}),
      () =>
        someone.page.call().admin.resendInvitation({
          invitationId: "00000000-0000-4000-8000-000000000001",
        }),
    ];
    for (const call of calls) {
      expect(await code(call())).toBe("access_denied");
    }
  });
});
