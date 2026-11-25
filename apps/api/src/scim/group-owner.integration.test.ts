/**
 * A base keeps an owner through a group's changes too: a member taken
 * out, the group's role changed or taken back, the group deleted, each is
 * refused when it would leave a base that had an owner with none, and
 * done when someone else still owns it.
 */
import { randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keyRing } from "../auth/key-ring.js";
import { setMemberRole } from "../data/members.js";
import { insertBase } from "../data/schema-ops.js";
import type { Env } from "../env.js";
import { createTestDatabase } from "../test-database.js";
import { browserFactory, signUpProved } from "../trpc/caller.test-helpers.js";
import {
  addLocalGroupMember,
  createLocalGroup,
  deleteLocalGroup,
  removeLocalGroupMember,
  setGroupRole,
} from "./groups.js";

const suffix = randomBytes(4).toString("hex");
const PASSWORD = "correct horse battery staple";

describe("a base's last owner, through a group", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let adminId = "";
  let personId = "";
  let baseId = "";
  let groupId = "";

  async function owners(): Promise<string[]> {
    const rows = await db
      .selectFrom("roleBindings")
      .select("userId")
      .distinct()
      .where("scope", "=", "base")
      .where("scopeId", "=", baseId)
      .where("role", "=", "owner")
      .execute();
    return rows.map((row) => row.userId).sort();
  }

  beforeAll(async () => {
    const created = await createTestDatabase("group_owner");
    db = created.db;
    close = created.close;
    const env = {
      AUTH_ENCRYPTION_KEY: keyRing(randomBytes(32)),
      PUBLIC_URL: "https://grid.example.org",
    } as unknown as Env;
    const browser = browserFactory({
      db: () => db,
      env,
      hub: { closeUser: () => 0, closeAllBut: () => 0, closeSession: () => 0 },
    });
    await browser().signUpFirst({
      email: `ada-${suffix}@example.org`,
      displayName: "Ada",
      password: PASSWORD,
    });
    adminId = (
      await db
        .selectFrom("users")
        .select("id")
        .where("email", "=", `ada-${suffix}@example.org`)
        .executeTakeFirstOrThrow()
    ).id;
    personId = await signUpProved(browser(), db, {
      email: `bea-${suffix}@example.org`,
      displayName: "Bea",
      password: PASSWORD,
    });
    baseId = (await insertBase(db, adminId, { name: `Ledger ${suffix}` })).id;
    groupId = (
      await createLocalGroup(db, adminId, {
        displayName: `Keepers ${suffix}`,
        description: null,
      })
    ).id;
    await setGroupRole(db, adminId, { baseId, groupId, role: "owner" });
    await addLocalGroupMember(db, adminId, { groupId, userId: personId });
    // Ada steps down: Bea owns the base through the group alone.
    await setMemberRole(db, adminId, {
      baseId,
      userId: adminId,
      role: "editor",
    });
    expect(await owners()).toEqual([personId]);
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  it("refuses every change to the group that would leave the base with no owner", async () => {
    const refused = { code: "invalid_owner" };
    await expect(
      removeLocalGroupMember(db, adminId, { groupId, userId: personId }),
    ).rejects.toMatchObject(refused);
    await expect(
      setGroupRole(db, adminId, { baseId, groupId, role: "editor" }),
    ).rejects.toMatchObject(refused);
    await expect(
      setGroupRole(db, adminId, { baseId, groupId, role: null }),
    ).rejects.toMatchObject(refused);
    await expect(deleteLocalGroup(db, adminId, groupId)).rejects.toMatchObject(
      refused,
    );
    // Nothing of any of them was kept.
    expect(await owners()).toEqual([personId]);
  });

  it("does them once someone else owns the base", async () => {
    await setMemberRole(db, adminId, {
      baseId,
      userId: adminId,
      role: "owner",
    });
    await removeLocalGroupMember(db, adminId, { groupId, userId: personId });
    await setGroupRole(db, adminId, { baseId, groupId, role: "editor" });
    await deleteLocalGroup(db, adminId, groupId);
    expect(await owners()).toEqual([adminId]);
  });
});
