/**
 * The administration API (ADR 0086), against a real database and a mail
 * server: a token is made with the proof and revoked at once; a request
 * is taken with a token of this API alone, while its maker is an active
 * administrator, and for the scopes it names; an account made with one is
 * no administrator and has no role; a setting that decides who gets in is
 * refused, and the others go through the rules the screen has; what a
 * token does is on the trails under its maker's name.
 */
import { randomBytes } from "node:crypto";
import cookie from "@fastify/cookie";
import { API_SETTING_KEYS } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setUserAdmin, setUserDisabled } from "./admin.js";
import { registerAdminApi } from "./admin-api.js";
import { keyRing } from "./auth/key-ring.js";
import { SESSION_COOKIE } from "./auth/session.js";
import { createApiToken } from "./auth/tokens.js";
import { createInvitation } from "./data/sharing.js";
import { insertBase } from "./data/schema-ops.js";
import type { Env } from "./env.js";
import { clearSmtpCache } from "./integrations/smtp.js";
import { fakeSmtp, mailText } from "./mail.test-helpers.js";
import { createScimToken } from "./scim/tokens.js";
import { createTestDatabase } from "./test-database.js";
import {
  browserFactory,
  enrollTotp,
  errorCode,
  signUpProved,
  type TestBrowser,
} from "./trpc/caller.test-helpers.js";

const suffix = randomBytes(6).toString("hex");
const PASSWORD = "correct horse battery staple";
const address = (name: string) => `${name}-${suffix}@example.org`;

describe("the administration API", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let smtp: Awaited<ReturnType<typeof fakeSmtp>>;
  let app: FastifyInstance;
  const closed: string[] = [];
  const env = {
    AUTH_ENCRYPTION_KEY: keyRing(randomBytes(32)),
    PUBLIC_URL: "https://grid.example.org",
    SMTP_FROM: "grid@example.org",
  } as unknown as Env & {
    SMTP_HOST?: string;
    SMTP_PORT?: number;
    ATTACHMENT_MAX_BYTES?: number;
  };
  const hub = {
    closeUser: () => 0,
    closeAllBut: () => 0,
    closeSession: () => 0,
  };
  const browser = browserFactory({ db: () => db, env, hub });
  let admin: TestBrowser;
  let adminId = "";

  /** A token of the administrator's, for these scopes. */
  const token = async (
    scopes: Array<"accounts" | "invitations" | "settings">,
    by: TestBrowser = admin,
  ) =>
    (await by.call().admin.apiTokens.create({ name: scopes.join("+"), scopes }))
      .token;
  const call = (
    method: "GET" | "POST" | "PATCH",
    path: string,
    bearer: string | null,
    payload?: object,
    headers: Record<string, string> = {},
  ) =>
    app.inject({
      method,
      url: `/api/v1/admin${path}`,
      headers: {
        ...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }),
        ...headers,
      },
      ...(payload === undefined ? {} : { payload }),
    });
  const code = (answer: { json: () => unknown }) =>
    (answer.json() as { code?: string; detail?: string }).code;
  const trail = async (action: string) =>
    db
      .selectFrom("authEvents")
      .select(["userId", "actorId", "method", "detail"])
      .where("action", "=", action as never)
      .where("method", "=", "admin_token")
      .orderBy("occurredAt")
      .execute();

  beforeAll(async () => {
    const created = await createTestDatabase("admin_api");
    db = created.db;
    close = created.close;
    smtp = await fakeSmtp();
    env.SMTP_HOST = "127.0.0.1";
    env.SMTP_PORT = smtp.port;
    admin = browser();
    await admin.signUpFirst({
      email: address("admin"),
      displayName: "Ada Admin",
      password: PASSWORD,
    });
    adminId = (
      await db
        .selectFrom("users")
        .select("id")
        .where("email", "=", address("admin"))
        .executeTakeFirstOrThrow()
    ).id;
    await enrollTotp(admin);
    app = Fastify();
    await app.register(cookie);
    registerAdminApi(app, {
      db,
      env,
      closeUser: (userId) => {
        closed.push(userId);
      },
    });
    await app.ready();
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await smtp.close();
    await close?.();
  });

  beforeEach(() => {
    smtp.received.length = 0;
    closed.length = 0;
  });

  it("makes a token with the proof, shows it once, and revokes it at once", async () => {
    // Making one is a change of Administration: no proof, no token.
    expect(
      await errorCode(
        admin
          .call()
          .admin.apiTokens.create({ name: "CI", scopes: ["accounts"] }),
      ),
    ).toBe("step_up_required");
    await admin.call().admin.stepUp({ password: PASSWORD });
    const made = await admin.call().admin.apiTokens.create({
      name: "CI",
      scopes: ["settings", "accounts"],
      days: 7,
    });
    expect(made.token).toMatch(/^aga_[A-Za-z0-9_-]{43}$/);
    expect(Date.parse(made.expiresAt)).toBeGreaterThan(
      Date.now() + 6 * 86_400_000,
    );
    const listed = await admin.call().admin.apiTokens.list();
    expect(listed.url).toBe("https://grid.example.org/api/v1/admin");
    expect(listed.tokens).toMatchObject([
      {
        id: made.id,
        name: "CI",
        // In the order the product names them, whatever was sent.
        scopes: ["accounts", "settings"],
        createdBy: "Ada Admin",
        active: true,
        lastUsedAt: null,
      },
    ]);
    // Neither the token nor its hash is ever listed.
    expect(JSON.stringify(listed)).not.toContain(made.token);
    expect(JSON.stringify(listed)).not.toMatch(/[0-9a-f]{64}/);
    expect((await call("GET", "/settings", made.token)).statusCode).toBe(200);
    expect(
      (await admin.call().admin.apiTokens.list()).tokens[0]?.lastUsedAt,
    ).not.toBeNull();

    // Longer than the policy lets a token live: refused. And a policy
    // made shorter holds for the tokens made before it.
    await admin.call().admin.updateSettings({ tokenMaxDays: 60 });
    expect(
      await errorCode(
        admin.call().admin.apiTokens.create({
          name: "Long",
          scopes: ["accounts"],
          days: 61,
        }),
      ),
    ).toBe("token_lifetime_too_long");
    const sixty = await admin.call().admin.apiTokens.create({
      name: "Sixty",
      scopes: ["settings"],
      days: 60,
    });
    await admin.call().admin.updateSettings({ tokenMaxDays: 30 });
    const shortened = (await admin.call().admin.apiTokens.list()).tokens.find(
      (item) => item.id === sixty.id,
    );
    expect(Date.parse(shortened?.expiresAt ?? "")).toBeLessThan(
      Date.now() + 31 * 86_400_000,
    );
    await db
      .updateTable("adminTokens")
      .set({ createdAt: new Date(Date.now() - 31 * 86_400_000) })
      .where("id", "=", sixty.id)
      .execute();
    expect((await call("GET", "/settings", sixty.token)).statusCode).toBe(401);
    await admin.call().admin.updateSettings({ tokenMaxDays: 365 });
    await admin.call().admin.apiTokens.revoke({ tokenId: sixty.id });
    // No scope, an unknown one, one named twice: refused.
    for (const scopes of [[], ["everything"], ["accounts", "accounts"]]) {
      expect(
        await errorCode(
          admin
            .call()
            .admin.apiTokens.create({ name: "Bad", scopes: scopes as never }),
        ),
      ).toBe("BAD_REQUEST");
    }

    // The change trail has the making and the revoking, without the hash.
    await admin.call().admin.apiTokens.revoke({ tokenId: made.id });
    expect((await call("GET", "/settings", made.token)).statusCode).toBe(401);
    const events = await db
      .selectFrom("auditEvents")
      .select(["action", "userId", "oldValue", "newValue"])
      .where("catalogTable", "=", "admin_tokens")
      .orderBy("occurredAt")
      .execute();
    // Two tokens made and revoked: each a line of the administrator's.
    expect(
      events.map((event) => [
        event.action,
        event.userId,
        (event.newValue as { name?: string } | null)?.name ?? null,
        (event.oldValue as { name?: string } | null)?.name ?? null,
      ]),
    ).toEqual([
      ["catalog", adminId, "CI", null],
      ["catalog", adminId, "Sixty", null],
      ["catalog", adminId, null, "Sixty"],
      ["catalog", adminId, null, "CI"],
    ]);
    expect(JSON.stringify(events)).not.toContain("token_hash");
    expect(JSON.stringify(events)).not.toMatch(/[0-9a-f]{64}/);
    expect(JSON.stringify(events)).toContain('"scopes"');
  });

  it("takes a token of this API only, while its maker is an active administrator", async () => {
    const good = await token(["settings"]);
    expect((await call("GET", "/settings", good)).statusCode).toBe(200);
    // No token, a made-up one, a base's token, a provisioning token, a
    // session: none opens Administration.
    const dataToken = (await createApiToken(db, adminId, "data")).token;
    const scimToken = (await createScimToken(db, adminId, "Okta")).token;
    for (const bearer of [
      null,
      `aga_${"A".repeat(43)}`,
      "aga_short",
      dataToken,
      scimToken,
    ]) {
      const refused = await call("GET", "/settings", bearer);
      expect([bearer?.slice(0, 8), refused.statusCode]).toEqual([
        bearer?.slice(0, 8),
        401,
      ]);
      expect(code(refused)).toBe("unauthenticated");
    }
    const withSession = await call("GET", "/settings", null, undefined, {
      cookie: `${SESSION_COOKIE}=${admin.jar[SESSION_COOKIE] ?? ""}`,
    });
    expect(withSession.statusCode).toBe(401);
    // A token that outlived its time, by its own date or the policy's.
    await db
      .updateTable("adminTokens")
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where("name", "=", "settings")
      .execute();
    expect((await call("GET", "/settings", good)).statusCode).toBe(401);

    // A second administrator's token stops with their role, and with
    // their account, and works again when they are one again.
    const second = browser();
    const secondId = await signUpProved(second, db, {
      email: address("second"),
      displayName: "Sam Second",
      password: PASSWORD,
    });
    await setUserAdmin(db, adminId, secondId, true);
    await enrollTotp(second);
    await second.call().admin.stepUp({ password: PASSWORD });
    const theirs = await token(["settings"], second);
    expect((await call("GET", "/settings", theirs)).statusCode).toBe(200);
    await setUserAdmin(db, adminId, secondId, false);
    expect((await call("GET", "/settings", theirs)).statusCode).toBe(401);
    expect(
      (await admin.call().admin.apiTokens.list()).tokens.find(
        (item) => item.createdBy === "Sam Second",
      )?.active,
    ).toBe(false);
    await setUserAdmin(db, adminId, secondId, true);
    expect((await call("GET", "/settings", theirs)).statusCode).toBe(200);
    await setUserDisabled(db, adminId, secondId, true);
    expect((await call("GET", "/settings", theirs)).statusCode).toBe(401);
  });

  it("does what its scopes name, and nothing else", async () => {
    const invitations = await token(["invitations"]);
    expect((await call("GET", "/invitations", invitations)).statusCode).toBe(
      200,
    );
    for (const [method, path, payload] of [
      ["GET", "/accounts", undefined],
      ["POST", "/accounts", { email: address("x"), displayName: "X" }],
      ["GET", "/settings", undefined],
      ["PATCH", "/settings", { banner: "Hello" }],
    ] as const) {
      const refused = await call(method, path, invitations, payload);
      expect([method, path, refused.statusCode, code(refused)]).toEqual([
        method,
        path,
        403,
        "admin_token_scope",
      ]);
    }
    // The answer names the scope that was missing.
    expect(
      (await call("GET", "/accounts", invitations)).json<{ detail: string }>()
        .detail,
    ).toBe("accounts");
    expect(await trail("account_created")).toEqual([]);
  });

  it("lists the invitations that wait, and the accounts a page at a time", async () => {
    const base = await insertBase(db, adminId, { name: "Shared" });
    await createInvitation(db, {
      baseId: base.id,
      email: address("guest"),
      role: "viewer",
      invitedBy: adminId,
    });
    const both = await token(["accounts", "invitations"]);
    const pending = (await call("GET", "/invitations", both)).json<{
      invitations: Array<{ email: string; baseName: string; role: string }>;
    }>();
    expect(pending.invitations).toMatchObject([
      { email: address("guest"), baseName: "Shared", role: "viewer" },
    ]);
    const page = (
      await call("GET", "/accounts?admin=true&limit=1&sort=name", both)
    ).json<{
      users: Array<Record<string, unknown>>;
      total: number;
    }>();
    expect(page.users).toHaveLength(1);
    expect(page.total).toBeGreaterThanOrEqual(1);
    expect(page.users[0]).toMatchObject({ isAdmin: true });
    // Never a secret: no hash, no token, nothing sealed.
    expect(JSON.stringify(page)).not.toMatch(
      /hash|secret|ciphertext|nonce|aga_|ag_/i,
    );
    // A filter that is none is refused, not ignored.
    for (const query of ["?limit=1000", "?admin=yes", "?unknown=1"]) {
      const refused = await call("GET", `/accounts${query}`, both);
      expect([query, refused.statusCode, code(refused)]).toEqual([
        query,
        400,
        "invalid_input",
      ]);
    }
  });

  it("makes an account that is no administrator and has no role, and mails its first link", async () => {
    const accounts = await token(["accounts"]);
    const made = await call("POST", "/accounts", accounts, {
      email: address("New"),
      displayName: "Nell New",
    });
    expect(made.statusCode, made.body).toBe(200);
    const answer = made.json<{ userId: string; sent: boolean; to?: string }>();
    expect(answer).toMatchObject({ sent: true, to: address("new") });
    // The link goes to the address, never back to the caller.
    expect(made.body).not.toContain("/reset/");
    const mail = mailText(await smtp.next(address("new")));
    // The mail holds the link on a line of its own: read as that line, it
    // is this instance's address and nothing before or after it.
    const mailed =
      mail.split(/\r?\n/).find((line) => line.startsWith("https://")) ?? "";
    expect(mailed).toMatch(/^https:\/\/grid\.example\.org\/reset\/[\w-]{43}$/);
    expect(mail).toContain("Ada Admin");
    const account = await db
      .selectFrom("users")
      .select(["isAdmin", "isSupport", "isAuditor"])
      .where("id", "=", answer.userId)
      .executeTakeFirstOrThrow();
    expect(account).toEqual({
      isAdmin: false,
      isSupport: false,
      isAuditor: false,
    });
    expect(
      await db
        .selectFrom("roleBindings")
        .select("role")
        .where("userId", "=", answer.userId)
        .execute(),
    ).toEqual([]);
    // On the sign-in trail, under the maker's name, as done with a token.
    expect(await trail("account_created")).toEqual([
      {
        userId: answer.userId,
        actorId: adminId,
        method: "admin_token",
        detail: null,
      },
    ]);

    // What the screen gives with the proof, a token is refused: an
    // administrator, a role on a base. And nothing is made of the try.
    const base = await insertBase(db, adminId, { name: "Ledger" });
    for (const extra of [
      { admin: true },
      { memberships: [{ baseId: base.id, role: "owner" }] },
      { isAdmin: true },
    ]) {
      const refused = await call("POST", "/accounts", accounts, {
        email: address("sly"),
        displayName: "Sly",
        ...extra,
      });
      expect([
        Object.keys(extra)[0],
        refused.statusCode,
        code(refused),
      ]).toEqual([Object.keys(extra)[0], 400, "invalid_input"]);
    }
    expect(
      await db
        .selectFrom("users")
        .select("id")
        .where("email", "=", address("sly"))
        .execute(),
    ).toEqual([]);
    const again = await call("POST", "/accounts", accounts, {
      email: address("new"),
      displayName: "Nell Again",
    });
    expect([again.statusCode, code(again)]).toEqual([
      409,
      "account_already_exists",
    ]);

    // Where no mail goes out, the link comes back once, as on screen.
    delete env.SMTP_HOST;
    clearSmtpCache(db);
    const handed = (
      await call("POST", "/accounts", accounts, {
        email: address("offline"),
        displayName: "Olly Offline",
      })
    ).json<{ sent: boolean; link?: string; expiresAt?: string }>();
    expect(handed.sent).toBe(false);
    expect(handed.link).toMatch(
      /^https:\/\/grid\.example\.org\/reset\/[\w-]{43}$/,
    );
    env.SMTP_HOST = "127.0.0.1";
    clearSmtpCache(db);
  });

  it("reads the settings, and changes those of the instance's running by the screen's rules", async () => {
    const settings = await token(["settings"]);
    const member = browser();
    const memberId = await signUpProved(member, db, {
      email: address("member"),
      displayName: "Max Member",
      password: PASSWORD,
    });
    const read = (await call("GET", "/settings", settings)).json<
      Record<string, unknown>
    >();
    expect(read).toMatchObject({ maintenance: false, mfaScope: "owners" });

    const changed = await call("PATCH", "/settings", settings, {
      banner: "Back at noon",
      maintenance: true,
    });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json()).toMatchObject({
      banner: "Back at noon",
      maintenance: true,
    });
    // Maintenance signs the others out, as it does from the screen.
    expect(closed).toContain(memberId);
    expect(closed).not.toContain(adminId);
    expect(await member.call().session.current()).toBeNull();
    // Each setting changed is on the sign-in trail, under the maker's
    // name, as changed with a token.
    expect(
      (await trail("settings_changed"))
        .map((event) => [event.actorId, event.detail])
        .sort(),
    ).toEqual([
      [adminId, "banner"],
      [adminId, "maintenance"],
    ]);
    await call("PATCH", "/settings", settings, { maintenance: false });

    // What decides who gets in, and what the instance says of itself:
    // named in the refusal, and left as it was, whatever came with it.
    for (const [key, value] of [
      ["mfaScope", "admins"],
      ["signup", "open"],
      ["signInAllowlist", []],
      ["lockoutThreshold", 100],
      ["passwordMinLength", 8],
      ["tokenMaxDays", 365],
      ["apiTokens", "everyone"],
      ["publicLinks", true],
      ["instanceName", "Other"],
      ["signInMessage", "Call this number"],
    ] as const) {
      const refused = await call("PATCH", "/settings", settings, {
        banner: "Changed with it",
        [key]: value,
      });
      expect([
        key,
        refused.statusCode,
        code(refused),
        refused.json<{ detail: string }>().detail,
      ]).toEqual([key, 403, "admin_token_setting", key]);
    }
    const after = (await call("GET", "/settings", settings)).json<
      Record<string, unknown>
    >();
    expect(after).toMatchObject({
      banner: "Back at noon",
      mfaScope: "owners",
      signup: read.signup,
      instanceName: read.instanceName,
    });
    // A key the product does not have, a value that is none: refused.
    for (const payload of [{ color: "red" }, { maintenance: "yes" }, []]) {
      const refused = await call("PATCH", "/settings", settings, payload);
      expect([refused.statusCode, code(refused)]).toEqual([
        400,
        "invalid_input",
      ]);
    }
    // What the instance's environment holds is its operator's.
    env.ATTACHMENT_MAX_BYTES = 1_000_000;
    const held = await call("PATCH", "/settings", settings, {
      attachmentMaxBytes: 2_000_000,
    });
    expect([held.statusCode, code(held)]).toEqual([409, "set_by_environment"]);
    delete env.ATTACHMENT_MAX_BYTES;
  });

  it("describes itself, from the schemas its requests are read with", async () => {
    // The document needs no token.
    const answer = await call("GET", "/openapi.json", null);
    expect(answer.statusCode).toBe(200);
    const document = answer.json<{
      openapi: string;
      servers: Array<{ url: string }>;
      paths: Record<string, Record<string, { "x-scope"?: string }>>;
      components: {
        schemas: Record<
          string,
          {
            properties?: Record<string, unknown>;
            additionalProperties?: boolean;
          }
        >;
      };
    }>();
    expect(document.openapi).toBe("3.1.0");
    expect(document.servers[0]?.url).toBe(
      "https://grid.example.org/api/v1/admin",
    );
    expect(
      Object.entries(document.paths).flatMap(([path, methods]) =>
        Object.entries(methods).map(
          ([method, operation]) =>
            `${method.toUpperCase()} ${path} ${operation["x-scope"] ?? ""}`,
        ),
      ),
    ).toEqual([
      "GET /accounts accounts",
      "POST /accounts accounts",
      "GET /invitations invitations",
      "GET /settings settings",
      "PATCH /settings settings",
    ]);
    // The settings a token may change are the ones the server takes.
    const patch = document.components.schemas.SettingsPatch;
    expect(Object.keys(patch?.properties ?? {}).sort()).toEqual(
      [...API_SETTING_KEYS].sort(),
    );
    expect(patch?.additionalProperties).toBe(false);
    expect(
      Object.keys(document.components.schemas.NewAccount?.properties ?? {}),
    ).toEqual(["email", "displayName"]);
  });
});
