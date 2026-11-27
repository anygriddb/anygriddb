/**
 * A person's notices go where their preferences say (ADR 0123): the bell,
 * a mail at once, or a digest; a digest's link stops it whole; a notice
 * the person cannot turn off offers no way out.
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keyRing } from "../auth/key-ring.js";
import type { Env } from "../env.js";
import { resolveSmtp } from "../integrations/smtp.js";
import { fakeSmtp, mailText } from "../mail.test-helpers.js";
import { recordingBus } from "../realtime/recording-bus.test-helpers.js";
import { createTestDatabase } from "../test-database.js";
import { browserFactory, signUpProved } from "../trpc/caller.test-helpers.js";
import { deliverPersonNotices, type DeliverDeps } from "./deliver-person.js";
import { grantMember, revokeMember } from "../data/members.js";
import { insertBase, insertTable } from "../data/schema-ops.js";
import { sendDigests } from "./digest.js";
import { channelsFor, savePreference } from "./person-preferences.js";
import { unsubscribeToken } from "./unsubscribe.js";

const suffix = randomBytes(6).toString("hex");
const PASSWORD = "correct horse battery staple";

describe("a person's notices", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let smtp: Awaited<ReturnType<typeof fakeSmtp>>;
  let deps: DeliverDeps;
  let userId = "";
  const address = `reader-${suffix}@example.org`;
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
  const reader = browser();
  const stranger = browser();

  beforeAll(async () => {
    const created = await createTestDatabase("person_delivery");
    db = created.db;
    close = created.close;
    smtp = await fakeSmtp();
    env.SMTP_HOST = "127.0.0.1";
    env.SMTP_PORT = smtp.port;
    userId = await signUpProved(reader, db, {
      email: address,
      displayName: "Rita Reader",
      password: PASSWORD,
    });
    deps = {
      db,
      bus: recordingBus().bus,
      smtp: (await resolveSmtp(db, env)).config,
      webOrigin: env.PUBLIC_URL,
      log: () => undefined,
      keys: env.AUTH_ENCRYPTION_KEY,
    };
  }, 120_000);

  afterAll(async () => {
    await smtp.close();
    await close?.();
  });

  it("waits for the digest when the person chose it, then sends it once", async () => {
    await savePreference(db, userId, "mention", ["in_app", "email_daily"]);
    await deliverPersonNotices(deps, [
      {
        userId,
        event: "mention",
        bellKind: "mention",
        data: { table: "Factures" },
        link: `${env.PUBLIC_URL}/t/x`,
      },
    ]);
    expect(smtp.received).toHaveLength(0);

    expect(await sendDigests({ db, env, log: () => undefined }, "daily")).toBe(
      1,
    );
    const text = mailText(await smtp.next(address));
    expect(text).toContain("Factures");
    expect(text).toContain("Stop this daily digest");
    // Sent once: what it listed is gone.
    expect(await sendDigests({ db, env, log: () => undefined }, "daily")).toBe(
      0,
    );
  });

  it("leaves out of a digest a notice of a table the person no longer reads", async () => {
    const ownerId = await signUpProved(browser(), db, {
      email: `owner-${suffix}@example.org`,
      displayName: "Otto Owner",
      password: PASSWORD,
    });
    const baseId = (await insertBase(db, ownerId, { name: "Ledger" })).id;
    const tableId = (
      await insertTable(db, ownerId, {
        baseId,
        name: "Salaires",
        columns: [{ name: "name", label: "Name", fieldType: "text" }],
      })
    ).id;
    await grantMember(db, ownerId, { baseId, email: address, role: "viewer" });
    await savePreference(db, userId, "row_changed", ["in_app", "email_daily"]);
    const notice = {
      userId,
      event: "row_changed" as const,
      bellKind: "row_changed" as const,
      data: { table: "Salaires" },
      tableId,
      baseId,
      link: `${env.PUBLIC_URL}/t/${tableId}`,
    };
    await deliverPersonNotices(deps, [notice]);
    // Taken out of the base before the digest goes: it says nothing of it.
    await revokeMember(db, ownerId, { baseId, userId });
    expect(await sendDigests({ db, env, log: () => undefined }, "daily")).toBe(
      0,
    );
    const left = await db
      .selectFrom("notificationDigestItems")
      .select("id")
      .where("userId", "=", userId)
      .execute();
    expect(left).toEqual([]);
    // Back in the base, the next notice is sent.
    await grantMember(db, ownerId, { baseId, email: address, role: "viewer" });
    await deliverPersonNotices(deps, [notice]);
    expect(await sendDigests({ db, env, log: () => undefined }, "daily")).toBe(
      1,
    );
    expect(mailText(await smtp.next(address))).toContain("Salaires");
  });

  it("stops the whole digest from its link, without a session", async () => {
    await savePreference(db, userId, "reply", ["in_app", "email_daily"]);
    const token = unsubscribeToken(env.AUTH_ENCRYPTION_KEY, {
      userId,
      event: null,
      channel: "email_daily",
    });
    const answer = await stranger.call().notifications.unsubscribe({ token });
    expect(answer.ok).toBe(true);
    expect(await channelsFor(db, userId, "mention")).toEqual(["in_app"]);
    expect(await channelsFor(db, userId, "reply")).toEqual(["in_app"]);
  });

  it("offers no way out of a notice the person cannot turn off", async () => {
    await deliverPersonNotices(deps, [
      {
        userId,
        event: "password_changed",
        mail: { subject: "Your password was changed", text: "It was." },
      },
    ]);
    const text = mailText(await smtp.next(address));
    expect(text).toContain("Your password was changed");
    expect(text).not.toContain("/notify/unsubscribe/");

    const forged = unsubscribeToken(env.AUTH_ENCRYPTION_KEY, {
      userId,
      event: "password_changed",
      channel: "email_immediate",
    });
    const answer = await stranger
      .call()
      .notifications.unsubscribe({ token: forged });
    expect(answer).toMatchObject({ ok: false, reason: "required" });
    expect(await channelsFor(db, userId, "password_changed")).toContain(
      "email_immediate",
    );
  });

  it("refuses a link it did not sign", async () => {
    const answer = await stranger.call().notifications.unsubscribe({
      token: `${"a".repeat(30)}~${"b".repeat(43)}`,
    });
    expect(answer).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("keeps a mute only on a base or a table its person reaches, and answers alike", async () => {
    const other = (
      await db
        .insertInto("users")
        .values({ email: `other-${suffix}@example.org`, displayName: "Other" })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;
    const theirs = (await insertBase(db, other, { name: "Theirs" })).id;
    const kept = () =>
      db
        .selectFrom("notificationMutes")
        .select(["baseId", "tableId"])
        .where("userId", "=", userId)
        .execute();
    const before = await kept();
    for (const baseId of [theirs, randomUUID()]) {
      expect(await reader.call().notifications.addMute({ baseId })).toEqual({
        ok: true,
      });
    }
    expect(await kept()).toEqual(before);
    await grantMember(db, other, {
      baseId: theirs,
      email: address,
      role: "viewer",
    });
    await reader.call().notifications.addMute({ baseId: theirs });
    expect(await kept()).toContainEqual({ baseId: theirs, tableId: null });
  });
});
