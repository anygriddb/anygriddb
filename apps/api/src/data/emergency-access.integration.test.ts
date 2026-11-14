/**
 * Emergency access (ROADMAP #35): an administrator reads a base they are
 * not a member of, for an hour, with a reason, and its owners are told.
 * The same notice goes out when an administrator gives themselves a role.
 */
import { randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keyRing } from "../auth/key-ring.js";
import type { Env } from "../env.js";
import { fakeSmtp, mailText } from "../mail.test-helpers.js";
import { createTestDatabase } from "../test-database.js";
import {
  browserFactory,
  enrollTotp,
  errorCode as code,
  signUpProved,
} from "../trpc/caller.test-helpers.js";
import { setMemberRole } from "./members.js";

const suffix = randomBytes(6).toString("hex");
const PASSWORD = "correct horse battery staple";
const REASON = "An invoice blocks the month's closing.";

describe("emergency access to a base", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let smtp: Awaited<ReturnType<typeof fakeSmtp>>;
  let adminId = "";
  let ownerId = "";
  let coOwnerId = "";
  let baseId = "";
  let tableId = "";
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
  const owner = browser();
  const coOwner = browser();
  const at = (name: string) => `${name}-${suffix}@example.org`;
  const idOf = async (email: string) =>
    (
      await db
        .selectFrom("users")
        .select("id")
        .where("email", "=", email)
        .executeTakeFirstOrThrow()
    ).id;
  const read = (page: ReturnType<typeof browser>, headers = {}) =>
    page.call(headers).rows.read({ tableId });
  const notices = (userId: string) =>
    db
      .selectFrom("notifications")
      .select(["kind", "actorId", "data"])
      .where("userId", "=", userId)
      .where("kind", "=", "admin_access")
      .orderBy("createdAt", "asc")
      .execute();
  const open = () =>
    admin.call().admin.baseOverview.open({ baseId, reason: REASON });

  beforeAll(async () => {
    const created = await createTestDatabase("emergency");
    db = created.db;
    close = created.close;
    smtp = await fakeSmtp();
    env.SMTP_HOST = "127.0.0.1";
    env.SMTP_PORT = smtp.port;
    await admin.call().auth.signup({
      email: at("admin"),
      displayName: "Ada Admin",
      password: PASSWORD,
    });
    await enrollTotp(admin);
    adminId = await idOf(at("admin"));
    ownerId = await signUpProved(owner, db, {
      email: at("owner"),
      displayName: "Olive Owner",
      password: PASSWORD,
    });
    await enrollTotp(owner);
    coOwnerId = await signUpProved(coOwner, db, {
      email: at("co"),
      displayName: "Cole Owner",
      password: PASSWORD,
    });
    await enrollTotp(coOwner);
    // The second owner wants no notification by mail: this one is not one.
    await db
      .updateTable("users")
      .set({ notifyByEmail: false })
      .where("id", "=", coOwnerId)
      .execute();
    baseId = (await owner.call().catalog.createBase({ name: "Ventes" })).id;
    await setMemberRole(db, ownerId, {
      baseId,
      userId: coOwnerId,
      role: "owner",
    });
    tableId = (
      await owner.call().catalog.createTable({
        baseId,
        name: "Factures",
        columns: [{ name: "title", label: "Title", fieldType: "text" }],
      })
    ).id;
    await owner
      .call()
      .rows.insertMany({ tableId, rows: [{ title: "A" }, { title: "B" }] });
  }, 120_000);

  afterAll(async () => {
    await smtp.close();
    await close?.();
  });

  it("keeps a base closed to an administrator who is not a member", async () => {
    expect(await code(read(admin))).not.toBe("ok");
    const bases = await admin.call().catalog.list();
    expect(bases.map((base) => base.id)).not.toContain(baseId);
  });

  it("asks the proof and a reason before it opens anything", async () => {
    expect(await code(open())).toBe("step_up_required");
    await admin.call().admin.stepUp({ password: PASSWORD });
    expect(
      await code(
        admin.call().admin.baseOverview.open({ baseId, reason: "   " }),
      ),
    ).toBe("BAD_REQUEST");
    expect(await code(read(admin))).not.toBe("ok");
    expect(await notices(ownerId)).toEqual([]);
  });

  it("is refused to anyone who does not administer the instance", async () => {
    expect(
      await code(
        owner.call().admin.baseOverview.open({ baseId, reason: REASON }),
      ),
    ).toBe("access_denied");
  });

  it("opens the base to read, and to nothing else, and tells its owners", async () => {
    const { expiresAt } = await open();
    const minutes = (new Date(expiresAt).getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(58);
    expect(minutes).toBeLessThan(61);

    // Reading: every row, and the base among the administrator's own.
    expect((await read(admin)).rows).toHaveLength(2);
    const mine = (await admin.call().catalog.list()).find(
      (base) => base.id === baseId,
    );
    expect(mine?.role).toBe("viewer");
    // Nothing else: no write, no comment, no member list.
    expect(
      await code(
        admin.call().rows.insertMany({ tableId, rows: [{ title: "C" }] }),
      ),
    ).not.toBe("ok");
    expect(await code(admin.call().catalog.members({ baseId }))).not.toBe("ok");

    // On the change trail, with the reason; never a value.
    const [event] = await db
      .selectFrom("auditEvents")
      .select(["userId", "reason", "newValue", "tableId"])
      .where("action", "=", "access")
      .execute();
    expect(event).toMatchObject({
      userId: adminId,
      reason: REASON,
      tableId: null,
      newValue: { baseId, base: "Ventes", until: expiresAt },
    });
    const trail = await admin.call().admin.audit({ action: "access" });
    expect(trail.events[0]).toMatchObject({
      baseName: "Ventes",
      reason: REASON,
      opened: { until: expiresAt },
      fields: [],
    });

    // Both owners are told, in the app and by mail, whatever they chose
    // for notifications; the administrator is not.
    for (const id of [ownerId, coOwnerId]) {
      expect(await notices(id)).toEqual([
        {
          kind: "admin_access",
          actorId: adminId,
          data: { baseId, base: "Ventes", reason: REASON, until: expiresAt },
        },
      ]);
    }
    expect(await notices(adminId)).toEqual([]);
    for (const address of [at("owner"), at("co")]) {
      const mail = mailText(await smtp.next(address));
      expect(mail).toMatch(
        /^Subject: AnyGridDB: an administrator opened "Ventes"/m,
      );
      expect(mail).toContain("Ada Admin, an administrator of AnyGridDB");
      expect(mail).toContain(REASON);
      expect(mail).toContain(`https://grid.example.org/b/${baseId}/settings`);
    }

    // Those who manage the base, and Administration, see who has it open.
    expect(await owner.call().catalog.openAccess({ baseId })).toEqual([
      {
        userId: adminId,
        displayName: "Ada Admin",
        reason: REASON,
        expiresAt,
      },
    ]);
    const page = await admin.call().admin.baseOverview.get({ baseId });
    expect(page.open.map((item) => item.userId)).toEqual([adminId]);
  });

  it("does not follow the administrator's API token", async () => {
    const { token } = await admin.call().auth.createToken({ name: "script" });
    expect(
      await code(read(browser(), { authorization: `Bearer ${token}` })),
    ).not.toBe("ok");
    // The session still reads.
    expect((await read(admin)).rows).toHaveLength(2);
  });

  it("ends by hand, with its hour, and with the administrator's role", async () => {
    expect(await admin.call().admin.baseOverview.close({ baseId })).toEqual({
      closed: true,
    });
    expect(await code(read(admin))).not.toBe("ok");
    expect(await owner.call().catalog.openAccess({ baseId })).toEqual([]);
    expect(await admin.call().admin.baseOverview.close({ baseId })).toEqual({
      closed: false,
    });

    // Its hour over.
    await open();
    expect((await read(admin)).rows).toHaveLength(2);
    await db
      .updateTable("emergencyAccess")
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where("endedAt", "is", null)
      .execute();
    expect(await code(read(admin))).not.toBe("ok");

    // No longer an administrator: the opening stops counting at once.
    await open();
    await db
      .updateTable("users")
      .set({ isAdmin: false })
      .where("id", "=", adminId)
      .execute();
    expect(await code(read(admin))).not.toBe("ok");
    await db
      .updateTable("users")
      .set({ isAdmin: true })
      .where("id", "=", adminId)
      .execute();
    await admin.call().admin.baseOverview.close({ baseId });
  });

  it("asks a reason of an administrator who gives themselves a role, and tells the owners", async () => {
    smtp.received.splice(0);
    const before = (await notices(ownerId)).length;
    const give = (reason?: string) =>
      admin.call().admin.setBaseRole({
        userId: adminId,
        baseId,
        role: "editor",
        ...(reason ? { reason } : {}),
      });
    expect(await code(give())).toBe("reason_required");
    expect(await code(read(admin))).not.toBe("ok");

    await give("Its owners asked for help with a formula.");
    expect((await read(admin)).rows).toHaveLength(2);
    const told = (await notices(ownerId)).slice(before);
    expect(told).toEqual([
      {
        kind: "admin_access",
        actorId: adminId,
        data: {
          baseId,
          base: "Ventes",
          reason: "Its owners asked for help with a formula.",
          role: "editor",
        },
      },
    ]);
    const mail = mailText(await smtp.next(at("owner")));
    expect(mail).toMatch(
      /^Subject: AnyGridDB: an administrator gave themselves a role on "Ventes"/m,
    );
    expect(mail).toContain("the role of editor");

    // A member has their role: there is nothing to open.
    expect(await code(open())).toBe("already_member");

    // A role given to someone else asks no reason, and sends no such notice.
    const guestId = await signUpProved(browser(), db, {
      email: at("guest"),
      displayName: "Gil Guest",
      password: PASSWORD,
    });
    await admin
      .call()
      .admin.setBaseRole({ userId: guestId, baseId, role: "viewer" });
    expect((await notices(ownerId)).slice(before)).toHaveLength(1);
  });
});
