/**
 * Handing a leaving person's work over (ROADMAP #21): the bases they alone
 * own, the automations and webhooks they made where the successor may
 * manage them, and their API tokens revoked when asked.
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
  errorCode as code,
  signUpProved,
} from "../trpc/caller.test-helpers.js";
import { ERASED_USER_ID } from "./erasure.js";
import { setMemberRole } from "./members.js";

const suffix = randomBytes(6).toString("hex");
const PASSWORD = "correct horse battery staple";

describe("handing a leaving person's work over", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let adminId = "";
  let leaId = "";
  let samId = "";
  let ottoId = "";
  let solo = { baseId: "", tableId: "" };
  let ottos = { baseId: "", tableId: "" };
  let joint = "";
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
  const lea = browser();
  const otto = browser();
  const at = (name: string) => `${name}-${suffix}@example.org`;
  const authorOf = async (kind: "automations" | "webhooks", name: string) =>
    kind === "automations"
      ? (
          await db
            .selectFrom("automations")
            .select("createdBy")
            .where("name", "=", name)
            .executeTakeFirstOrThrow()
        ).createdBy
      : (
          await db
            .selectFrom("webhooks")
            .select("createdBy")
            .where("name", "=", name)
            .executeTakeFirstOrThrow()
        ).createdBy;
  const ownersOf = async (baseId: string) =>
    (
      await db
        .selectFrom("roleBindings")
        .select("userId")
        .where("scope", "=", "base")
        .where("scopeId", "=", baseId)
        .where("role", "=", "owner")
        .execute()
    )
      .map((row) => row.userId)
      .sort();
  const automation = (tableId: string, name: string) =>
    db
      .insertInto("automations")
      .values({
        tableId,
        name,
        trigger: JSON.stringify({ type: "manual" }),
        actions: JSON.stringify([]),
        createdBy: leaId,
      })
      .execute();
  const webhook = (tableId: string, name: string) =>
    db
      .insertInto("webhooks")
      .values({
        tableId,
        name,
        kind: "http",
        target: "https://hooks.example.org/in",
        events: ["row.created"],
        secretCiphertext: Buffer.alloc(1),
        secretNonce: Buffer.alloc(1),
        createdBy: leaId,
      })
      .execute();
  const baseWithTable = async (
    page: ReturnType<typeof browser>,
    name: string,
  ) => {
    const baseId = (await page.call().catalog.createBase({ name })).id;
    const tableId = (
      await page.call().catalog.createTable({
        baseId,
        name: "Orders",
        columns: [{ name: "title", label: "Title", fieldType: "text" }],
      })
    ).id;
    return { baseId, tableId };
  };

  beforeAll(async () => {
    const created = await createTestDatabase("handoff");
    db = created.db;
    close = created.close;
    await admin.call().auth.signup({
      email: at("admin"),
      displayName: "Ada Admin",
      password: PASSWORD,
    });
    await enrollTotp(admin);
    await admin.call().admin.stepUp({ password: PASSWORD });
    adminId = (
      await db
        .selectFrom("users")
        .select("id")
        .where("email", "=", at("admin"))
        .executeTakeFirstOrThrow()
    ).id;
    leaId = await signUpProved(lea, db, {
      email: at("lea"),
      displayName: "Lea Leaving",
      password: PASSWORD,
    });
    await enrollTotp(lea);
    ottoId = await signUpProved(otto, db, {
      email: at("otto"),
      displayName: "Otto Other",
      password: PASSWORD,
    });
    await enrollTotp(otto);
    samId = (
      await db
        .insertInto("users")
        .values({ email: at("sam"), displayName: "Sam Staying" })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;

    // Lea's own base; a base she owns with Otto; Otto's base, where she
    // once made an automation.
    solo = await baseWithTable(lea, "Solo");
    joint = (await lea.call().catalog.createBase({ name: "Joint" })).id;
    await setMemberRole(db, leaId, {
      baseId: joint,
      userId: ottoId,
      role: "owner",
    });
    ottos = await baseWithTable(otto, "Ottos");
    await automation(solo.tableId, `Remind ${suffix}`);
    await automation(ottos.tableId, `Archive ${suffix}`);
    await webhook(solo.tableId, `Notify ${suffix}`);
    await lea.call().auth.createToken({ name: "script" });
    await lea.call().auth.createToken({ name: "report" });
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  it("says what there is to hand over, names only", async () => {
    expect(await admin.call().admin.handoffInfo({ userId: leaId })).toEqual({
      bases: [{ id: solo.baseId, name: "Solo" }],
      automations: [
        {
          id: expect.any(String) as string,
          name: `Archive ${suffix}`,
          table: "Orders",
          base: "Ottos",
        },
        {
          id: expect.any(String) as string,
          name: `Remind ${suffix}`,
          table: "Orders",
          base: "Solo",
        },
      ],
      webhooks: [
        {
          id: expect.any(String) as string,
          name: `Notify ${suffix}`,
          table: "Orders",
          base: "Solo",
        },
      ],
      tokens: 2,
    });
  });

  it("is an administrator's gesture, on someone else, for someone who stays", async () => {
    const hand = (page: ReturnType<typeof browser>, toUserId: string) =>
      page.call().admin.handOver({ fromUserId: leaId, toUserId });
    expect(await code(lea.call().admin.handoffInfo({ userId: ottoId }))).toBe(
      "access_denied",
    );
    expect(await code(hand(otto, samId))).toBe("access_denied");
    expect(await code(hand(admin, leaId))).toBe("invalid_account");
    expect(await code(hand(admin, ERASED_USER_ID))).toBe("unknown_account");
    expect(
      await code(
        admin.call().admin.handOver({ fromUserId: adminId, toUserId: samId }),
      ),
    ).toBe("invalid_account");
    await db
      .updateTable("users")
      .set({ disabledAt: new Date() })
      .where("id", "=", samId)
      .execute();
    expect(await code(hand(admin, samId))).toBe("unknown_account");
    await db
      .updateTable("users")
      .set({ disabledAt: null })
      .where("id", "=", samId)
      .execute();
    expect(await ownersOf(solo.baseId)).toEqual([leaId]);
  });

  it("hands over the bases they alone own and what the successor may manage", async () => {
    const result = await admin
      .call()
      .admin.handOver({ fromUserId: leaId, toUserId: samId });
    expect(result).toEqual({
      bases: 1,
      automations: {
        moved: 1,
        kept: [
          {
            id: expect.any(String) as string,
            name: `Archive ${suffix}`,
            table: "Orders",
            base: "Ottos",
          },
        ],
      },
      webhooks: { moved: 1, kept: [] },
      tokensRevoked: 0,
    });
    // The successor owns the base; the person's own role is left.
    expect(await ownersOf(solo.baseId)).toEqual([leaId, samId].sort());
    // A base owned with someone else already has an owner who stays.
    expect(await ownersOf(joint)).toEqual([leaId, ottoId].sort());
    expect(await authorOf("automations", `Remind ${suffix}`)).toBe(samId);
    expect(await authorOf("webhooks", `Notify ${suffix}`)).toBe(samId);
    // Sam has no role on Otto's base: that automation stays Lea's.
    expect(await authorOf("automations", `Archive ${suffix}`)).toBe(leaId);
    // Tokens are never moved, and stay until revoked.
    expect(
      await db
        .selectFrom("apiTokens")
        .select("userId")
        .where("userId", "in", [leaId, samId])
        .execute(),
    ).toEqual([{ userId: leaId }, { userId: leaId }]);
    // On the sign-in trail, under the administrator's name.
    expect(
      await db
        .selectFrom("authEvents")
        .select(["userId", "actorId", "method"])
        .where("action", "=", "account_updated")
        .where("detail", "=", "handed_over")
        .execute(),
    ).toEqual([{ userId: leaId, actorId: adminId, method: "admin" }]);
  });

  it("moves what was kept once the successor may manage it, and revokes tokens when asked", async () => {
    await setMemberRole(db, ottoId, {
      baseId: ottos.baseId,
      userId: samId,
      role: "owner",
    });
    const result = await admin.call().admin.handOver({
      fromUserId: leaId,
      toUserId: samId,
      revokeTokens: true,
    });
    expect(result).toEqual({
      // Solo has two owners now: nothing left to hand over there.
      bases: 0,
      automations: { moved: 1, kept: [] },
      webhooks: { moved: 0, kept: [] },
      tokensRevoked: 2,
    });
    expect(await authorOf("automations", `Archive ${suffix}`)).toBe(samId);
    expect(
      await db
        .selectFrom("apiTokens")
        .select("id")
        .where("userId", "=", leaId)
        .execute(),
    ).toEqual([]);
    expect(
      await db
        .selectFrom("authEvents")
        .select(["userId", "actorId"])
        .where("action", "=", "tokens_revoked")
        .execute(),
    ).toEqual([{ userId: leaId, actorId: adminId }]);
    // Nothing left: a third time changes nothing, and says so.
    expect(await admin.call().admin.handoffInfo({ userId: leaId })).toEqual({
      bases: [],
      automations: [],
      webhooks: [],
      tokens: 0,
    });
  });
});
