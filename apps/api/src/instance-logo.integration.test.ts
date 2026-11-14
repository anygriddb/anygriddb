/**
 * How the instance presents itself (ROADMAP #45, ADR 0072): the logo an
 * administrator sets, who may set it, how anyone reads it, and the name,
 * sender and signature every mail then carries.
 */
import { randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keyRing } from "./auth/key-ring.js";
import { insertBase } from "./data/schema-ops.js";
import type { Env } from "./env.js";
import { INSTANCE_LOGO_PATH, registerLogoRoute } from "./instance-logo.js";
import { fakeSmtp, mailText } from "./mail.test-helpers.js";
import { createTestDatabase } from "./test-database.js";
import {
  browserFactory,
  enrollTotp,
  errorCode as code,
  signUpProved,
} from "./trpc/caller.test-helpers.js";

const suffix = randomBytes(6).toString("hex");
const PASSWORD = "correct horse battery staple";

/** The smallest PNG: its signature, then anything. */
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  randomBytes(64),
]);
const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
);

describe("the instance's name, logo and mail", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let app: FastifyInstance;
  let smtp: Awaited<ReturnType<typeof fakeSmtp>>;
  let adminId = "";
  let memberId = "";
  const env = {
    AUTH_ENCRYPTION_KEY: keyRing(randomBytes(32)),
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
  const member = browser();
  const nobody = browser();
  const at = (name: string) => `${name}-${suffix}@example.org`;
  const logoEvents = () =>
    db
      .selectFrom("authEvents")
      .select(["actorId", "method"])
      .where("action", "=", "settings_changed")
      .where("detail", "=", "logo")
      .execute();
  const fetchLogo = (query = "", headers: Record<string, string> = {}) =>
    app.inject({
      method: "GET",
      url: `${INSTANCE_LOGO_PATH}${query}`,
      headers,
    });

  beforeAll(async () => {
    const created = await createTestDatabase("identity");
    db = created.db;
    close = created.close;
    smtp = await fakeSmtp();
    env.SMTP_HOST = "127.0.0.1";
    env.SMTP_PORT = smtp.port;
    app = Fastify();
    registerLogoRoute(app, { db });
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
    memberId = await signUpProved(member, db, {
      email: at("member"),
      displayName: "Mel Member",
      password: PASSWORD,
    });
    await enrollTotp(member);
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await smtp.close();
    await close?.();
  });

  it("is the product's until an administrator says otherwise", async () => {
    const instance = await nobody.call().auth.instance();
    expect(instance).toMatchObject({
      instanceName: null,
      signInMessage: null,
      logo: null,
    });
    expect((await fetchLogo()).statusCode).toBe(404);
  });

  it("keeps the image an administrator sends, and serves it to anyone", async () => {
    const { logo } = await admin
      .call()
      .admin.setLogo({ data: PNG.toString("base64") });
    expect(logo).toMatch(/^[0-9a-f]{16}$/);
    // Read without a session: the sign-in page shows it.
    expect((await nobody.call().auth.instance()).logo).toBe(logo);
    expect((await admin.call().admin.settings()).logo).toBe(logo);

    const byVersion = await fetchLogo(`?v=${logo}`);
    expect(byVersion.statusCode).toBe(200);
    expect(byVersion.headers["content-type"]).toBe("image/png");
    expect(byVersion.headers["cache-control"]).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(byVersion.rawPayload.equals(PNG)).toBe(true);

    // Without its version, or with an older one, it is checked each time.
    expect((await fetchLogo()).headers["cache-control"]).toBe("no-cache");
    expect(
      (await fetchLogo("?v=0000000000000000")).headers["cache-control"],
    ).toBe("no-cache");
    const unchanged = await fetchLogo("", {
      "if-none-match": String(byVersion.headers.etag),
    });
    expect(unchanged.statusCode).toBe(304);
    expect(unchanged.rawPayload).toHaveLength(0);

    expect(await logoEvents()).toEqual([{ actorId: adminId, method: "admin" }]);
  });

  it("refuses what its bytes do not prove to be an image", async () => {
    expect(
      await code(admin.call().admin.setLogo({ data: SVG.toString("base64") })),
    ).toBe("invalid_logo");
    expect(
      await code(
        admin.call().admin.setLogo({
          data: Buffer.from("GIF89a....").toString("base64"),
        }),
      ),
    ).toBe("invalid_logo");
    // More than the largest logo never reaches the bytes' check.
    const tooLarge = Buffer.concat([PNG, Buffer.alloc(262_144)]);
    expect(
      await code(
        admin.call().admin.setLogo({ data: tooLarge.toString("base64") }),
      ),
    ).toBe("BAD_REQUEST");
    // The logo kept is still the first.
    expect((await fetchLogo()).rawPayload.equals(PNG)).toBe(true);
    expect(await logoEvents()).toHaveLength(1);
  });

  it("is set by administrators only, as any setting", async () => {
    const data = PNG.toString("base64");
    expect(await code(nobody.call().admin.setLogo({ data }))).toBe(
      "UNAUTHORIZED",
    );
    expect(await code(member.call().admin.setLogo({ data }))).toBe(
      "access_denied",
    );
    expect(await code(member.call().admin.removeLogo())).toBe("access_denied");
    // An auditor reads the settings, the logo's version among them, and
    // changes nothing.
    await db
      .updateTable("users")
      .set({ isAuditor: true })
      .where("id", "=", memberId)
      .execute();
    expect((await member.call().admin.settings()).logo).toMatch(/^[0-9a-f]+$/);
    expect(await code(member.call().admin.setLogo({ data }))).toBe(
      "access_denied",
    );
    expect(await code(member.call().admin.removeLogo())).toBe("access_denied");
    expect(
      await code(
        member.call().admin.updateSettings({ instanceName: "Taken over" }),
      ),
    ).toBe("access_denied");
    expect(await logoEvents()).toHaveLength(1);
  });

  it("goes back to the product's mark when the logo is removed", async () => {
    expect(await admin.call().admin.removeLogo()).toEqual({ logo: null });
    expect((await nobody.call().auth.instance()).logo).toBeNull();
    expect((await fetchLogo()).statusCode).toBe(404);
    expect(await logoEvents()).toHaveLength(2);
    // Nothing to remove: nothing is written.
    await admin.call().admin.removeLogo();
    expect(await logoEvents()).toHaveLength(2);
  });

  it("refuses a name that would not fit on one line", async () => {
    expect(
      await code(
        admin.call().admin.updateSettings({
          mailSenderName: "Registre\r\nBcc: everyone@example.org",
        }),
      ),
    ).toBe("BAD_REQUEST");
    expect((await admin.call().admin.settings()).mailSenderName).toBeNull();
  });

  it("names the instance to everyone, and in every mail it sends", async () => {
    await admin.call().admin.updateSettings({
      defaultLocale: "fr",
      instanceName: "Registre des essais",
      signInMessage: "Réservé au personnel de l’étude.",
      mailSignatureFr: "L’équipe données\nsupport@example.org",
      mailInvitationFr:
        "Demandez l’accord de votre responsable avant de partager.",
    });
    expect(await nobody.call().auth.instance()).toMatchObject({
      instanceName: "Registre des essais",
      signInMessage: "Réservé au personnel de l’étude.",
    });

    await admin.call().admin.sendTestMail();
    const test = mailText(await smtp.next(at("admin")));
    expect(test).toMatch(/^From: Registre des essais <grid@example\.org>/m);
    expect(test).toMatch(
      /^Subject: Registre des essais\u00a0: message de test/m,
    );
    expect(test).toContain("-- \r\nL’équipe données\r\nsupport@example.org");

    // An invitation: the instance's name, its note, the link, its signature.
    const base = await insertBase(db, adminId, { name: `Essai ${suffix}` });
    await admin.call().catalog.invite({
      baseId: base.id,
      email: at("guest"),
      role: "viewer",
    });
    const invitation = mailText(await smtp.next(at("guest")));
    expect(invitation).toMatch(
      /^From: Registre des essais <grid@example\.org>/m,
    );
    expect(invitation).toContain(
      "Ada Admin vous invite sur Registre des essais.",
    );
    const note = invitation.indexOf("Demandez l’accord de votre responsable");
    const link = invitation.indexOf("https://grid.example.org/invite/");
    const signature = invitation.indexOf("-- \r\nL’équipe données");
    expect(note).toBeGreaterThan(0);
    expect(link).toBeGreaterThan(note);
    expect(signature).toBeGreaterThan(link);
    expect(invitation).not.toContain("AnyGridDB");

    // A sender name of its own takes the place of the instance's name.
    await admin.call().admin.updateSettings({ mailSenderName: "Support" });
    await admin.call().admin.sendTestMail();
    expect(mailText(await smtp.next(at("admin")))).toMatch(
      /^From: Support <grid@example\.org>/m,
    );
  });
});
