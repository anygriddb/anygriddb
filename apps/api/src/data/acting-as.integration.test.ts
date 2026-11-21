/**
 * An administrator acts as someone else (ADR 0091): the session stays
 * theirs, Administration closes, and the sign-in trail names both.
 */
import { randomBytes } from "node:crypto";
import cookie from "@fastify/cookie";
import type { Database } from "@anygriddb/db";
import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { SESSION_COOKIE, sessionIdentities } from "../auth/session.js";
import { keyRing } from "../auth/key-ring.js";
import { withAudit } from "./audit-context.js";
import { bindRole } from "./members.js";
import { registerActingRequests } from "../acting-requests.js";
import type { Env } from "../env.js";
import { recordingBus } from "../realtime/recording-bus.test-helpers.js";
import { registerRestApi } from "../rest-api.js";
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

  describe("with the person's rules, and none of the administrator's", () => {
    let adminId = "";
    let baseId = "";
    let tableId = "";
    const act = () =>
      admin.call().admin.startActing({ userId: memberId, reason: "Support" });

    beforeAll(async () => {
      adminId = (await admin.call().session.current())?.id ?? "";
      baseId = (await admin.call().catalog.createBase({ name: "Rules" })).id;
      await withAudit(db, { userId: adminId, source: "web" }, (tx) =>
        bindRole(tx, memberId, "editor", baseId),
      );
      tableId = (
        await admin.call().catalog.createTable({
          baseId,
          name: "Staff",
          columns: [
            { name: "who", label: "Who", fieldType: "text" },
            { name: "salary", label: "Salary", fieldType: "number" },
          ],
        })
      ).id;
      await admin.call().rows.insert({
        tableId,
        values: { who: "mine", salary: 1 },
      });
      await admin.call().rows.insert({
        tableId,
        values: { who: "theirs", salary: 2 },
      });
      await admin.call().catalog.setTableAcl({
        tableId,
        userId: memberId,
        rowFilter: {
          conjunction: "and",
          conditions: [{ column: "who", op: "is", value: "mine" }],
        },
        columns: [{ column: "who", access: "write" }],
      });
    });

    afterEach(async () => {
      await admin.call().admin.stopActing();
    });

    it("reads only the rows and fields the person may", async () => {
      await act();
      const page = await admin.call().rows.read({ tableId });
      expect(page.rows.map((row) => row.who)).toEqual(["mine"]);
      expect(page.rows[0]).not.toHaveProperty("salary");
    });

    it("holds to them on the REST API, by a session's cookie", async () => {
      const app = Fastify();
      await app.register(cookie);
      registerActingRequests(app, db);
      registerRestApi(app, {
        db,
        bus: recordingBus().bus,
        publicUrl: "https://grid.example.org",
      });
      await app.ready();
      try {
        await act();
        const answer = await app.inject({
          method: "GET",
          url: `/api/v1/tables/${tableId}/records`,
          cookies: { [SESSION_COOKIE]: admin.jar[SESSION_COOKIE] ?? "" },
        });
        expect(answer.statusCode).toBe(200);
        expect(answer.body).toContain("mine");
        expect(answer.body).not.toContain("theirs");
        expect(answer.body).not.toContain("salary");
      } finally {
        await app.close();
      }
    });

    it("sets aside what only an administrator may do", async () => {
      const noSource = "00000000-0000-4000-8000-0000000000aa";
      expect(
        await errorCode(
          admin.call().catalog.createBase({ name: "Held", sourceId: noSource }),
        ),
      ).not.toBe("access_denied");
      await act();
      expect(
        await errorCode(
          admin.call().catalog.createBase({ name: "Held", sourceId: noSource }),
        ),
      ).toBe("access_denied");
    });

    it("starts no job, which would run with the administrator's rights", async () => {
      await withAudit(db, { userId: adminId, source: "web" }, (tx) =>
        bindRole(tx, memberId, "owner", baseId),
      );
      await act();
      expect(
        await errorCode(admin.call().catalog.exportSnapshot({ baseId })),
      ).toBe("acting_no_job");
      await admin.call().admin.stopActing();
      await withAudit(db, { userId: adminId, source: "web" }, (tx) =>
        bindRole(tx, memberId, "editor", baseId),
      );
    });

    it("names the person whatever other header a request carries", async () => {
      await act();
      await admin
        .call({ authorization: "Basic eDp5" })
        .rows.insert({ tableId, values: { who: "mine" } });
      const event = await db
        .selectFrom("auditEvents")
        .select("impersonatedUserId")
        .where("tableId", "=", tableId)
        .orderBy("occurredAt", "desc")
        .executeTakeFirst();
      expect(event?.impersonatedUserId).toBe(memberId);
    });

    it("ends when its administrator is one no longer", async () => {
      await act();
      await db
        .updateTable("users")
        .set({ isAdmin: false })
        .where("id", "=", adminId)
        .execute();
      try {
        expect((await admin.call().session.current())?.actingAs).toBeNull();
      } finally {
        await db
          .updateTable("users")
          .set({ isAdmin: true })
          .where("id", "=", adminId)
          .execute();
      }
    });

    it("tells a socket whose rights its session holds now", async () => {
      await act();
      const row = await db
        .selectFrom("sessions")
        .select("tokenHash")
        .where("userId", "=", adminId)
        .where("impersonatedUserId", "=", memberId)
        .executeTakeFirstOrThrow();
      expect(
        (await sessionIdentities(db, [row.tokenHash])).get(row.tokenHash),
      ).toBe(memberId);
      await admin.call().admin.stopActing();
      expect(
        (await sessionIdentities(db, [row.tokenHash])).get(row.tokenHash),
      ).toBe(adminId);
    });
  });
});
