/**
 * An administrator acts as someone else (ADR 0091): the session stays
 * theirs, Administration closes, and the sign-in trail names both.
 */
import { randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keyRing } from "../auth/key-ring.js";
import type { Env } from "../env.js";
import { createTestDatabase } from "../test-database.js";
import {
  browserFactory,
  enrollTotp,
  errorCode,
  signUpProved,
} from "../trpc/caller.test-helpers.js";

const suffix = randomBytes(4).toString("hex");
const PASSWORD = "correct horse battery staple";

describe("acting as another person", () => {
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
    publish: () => Promise.resolve(),
  };
  const browser = browserFactory({ db: () => db, env, hub });
  const admin = browser();
  const member = browser();
  const at = (name: string) => `${name}-${suffix}@example.org`;
  let memberId = "";

  beforeAll(async () => {
    const created = await createTestDatabase("actingas");
    db = created.db;
    close = created.close;
    await admin.signUpFirst({
      email: at("admin"),
      displayName: "Ada Admin",
      password: PASSWORD,
    });
    await enrollTotp(admin);
    memberId = await signUpProved(member, db, {
      email: at("member"),
      displayName: "Sam Member",
      password: PASSWORD,
    });
    await admin.call().admin.stepUp({ password: PASSWORD });
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  it("refuses the administrator's own account", async () => {
    const me = await admin.call().session.current();
    expect(
      await errorCode(
        admin.call().admin.startActing({ userId: me?.id ?? "", reason: "me" }),
      ),
    ).toBe("cannot_act_as");
  });

  it("uses the person's rights, closes Administration, and stops", async () => {
    const started = await admin.call().admin.startActing({
      userId: memberId,
      reason: "See their home",
    });
    expect(started.until).toEqual(expect.any(String));
    const during = await admin.call().session.current();
    expect(during?.actingAs).toMatchObject({
      id: memberId,
      displayName: "Sam Member",
    });
    expect(during?.id).not.toBe(memberId);
    await admin.call().catalog.createBase({ name: `Seen ${suffix}` });
    const event = await db
      .selectFrom("auditEvents")
      .select(["userId", "impersonatedUserId"])
      .where("catalogTable", "=", "bases")
      .orderBy("occurredAt", "desc")
      .executeTakeFirst();
    expect(event).toMatchObject({
      userId: during?.id,
      impersonatedUserId: memberId,
    });
    expect(await errorCode(admin.call().admin.users({}))).toBe("acting_as");
  });

  it("records both people and lets the administrator stop twice", async () => {
    // The previous test left the session acting. Stop, then read the trail.
    const first = await admin.call().admin.stopActing();
    expect(first.stopped).toBe(true);
    expect((await admin.call().session.current())?.actingAs).toBeNull();
    const again = await admin.call().admin.stopActing();
    expect(again.stopped).toBe(false);
    const trail = await admin.call().admin.authAudit({ limit: 50 });
    const started = trail.events.find(
      (event) => event.action === "acting_as_started",
    );
    expect(started).toMatchObject({
      userId: memberId,
      detail: "See their home",
    });
    expect(started?.actorId).toBe((await admin.call().session.current())?.id);
    expect(
      trail.events.some((event) => event.action === "acting_as_ended"),
    ).toBe(true);
  });
});
