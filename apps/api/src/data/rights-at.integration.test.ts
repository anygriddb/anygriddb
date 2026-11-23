/**
 * Roles at a date, rebuilt from the live trail: own bindings, a group's,
 * a change undone, and a trail that no longer reaches the date.
 */
import { randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keyRing } from "../auth/key-ring.js";
import { insertBase } from "./schema-ops.js";
import { grantMember, setMemberRole } from "./members.js";
import { rightsAt } from "./rights-at.js";
import {
  addLocalGroupMember,
  createLocalGroup,
  setGroupRole,
} from "../scim/groups.js";
import type { Env } from "../env.js";
import { createTestDatabase } from "../test-database.js";
import { browserFactory, signUpProved } from "../trpc/caller.test-helpers.js";

const suffix = randomBytes(4).toString("hex");
const PASSWORD = "correct horse battery staple";

describe("rights at a date", () => {
  let db: Database;
  let ownerDb: Database;
  let close: (() => Promise<void>) | undefined;
  let adminId = "";
  let personId = "";
  let baseId = "";

  beforeAll(async () => {
    const created = await createTestDatabase("rights_at");
    db = created.db;
    ownerDb = created.owner.db;
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
    const admin = browser();
    await admin.signUpFirst({
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
    await grantMember(db, adminId, {
      baseId,
      email: `bea-${suffix}@example.org`,
      role: "viewer",
    });
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  it("reports the role held now, and refuses a date the trail does not reach", async () => {
    const now = await rightsAt(db, {
      userId: personId,
      at: new Date(Date.now() + 60_000),
    });
    expect(now.incomplete).toBe(false);
    if (now.incomplete) return;
    expect(now.lines).toEqual([
      expect.objectContaining({
        scope: "base",
        scopeId: baseId,
        role: "viewer",
        groupId: null,
      }),
    ]);

    const before = await rightsAt(db, {
      userId: personId,
      at: new Date("2020-01-01T00:00:00.000Z"),
    });
    expect(before.incomplete).toBe(true);
    if (!before.incomplete) return;
    expect(before.reason).toBe("purged");
    expect(before.earliestKept).not.toBeNull();
  });

  it("walks a role change backward, including one a group gives", async () => {
    const granted = await db
      .selectFrom("auditEvents")
      .select("occurredAt")
      .where("catalogTable", "=", "role_bindings")
      .where(
        sql<boolean>`coalesce(new_value->>'user_id', new_value->>'userId') = ${personId}`,
      )
      .orderBy("occurredAt", "asc")
      .executeTakeFirstOrThrow();

    await setMemberRole(db, adminId, {
      baseId,
      userId: personId,
      role: "editor",
    });

    const between = new Date(granted.occurredAt.getTime() + 1);
    const then = await rightsAt(db, { userId: personId, at: between });
    expect(then.incomplete).toBe(false);
    if (then.incomplete) return;
    const own = then.lines.find((line) => line.groupId === null);
    expect(own?.role).toBe("viewer");

    const group = await createLocalGroup(db, adminId, {
      displayName: `Finance ${suffix}`,
      description: null,
    });
    await setGroupRole(db, adminId, {
      baseId,
      groupId: group.id,
      role: "commenter",
    });
    await addLocalGroupMember(db, adminId, {
      groupId: group.id,
      userId: personId,
    });
    const withGroup = await rightsAt(db, {
      userId: personId,
      at: new Date(Date.now() + 60_000),
    });
    expect(withGroup.incomplete).toBe(false);
    if (withGroup.incomplete) return;
    expect(withGroup.lines.find((line) => line.groupId === group.id)).toEqual(
      expect.objectContaining({
        role: "commenter",
        groupName: `Finance ${suffix}`,
      }),
    );
  });

  it("says the trail is gone when the person's roles remain and every event was purged", async () => {
    await ownerDb.transaction().execute(async (tx) => {
      await sql`select set_config('anygrid.purge_audit', 'on', true)`.execute(
        tx,
      );
      await sql`delete from audit_events where catalog_table = 'role_bindings'`.execute(
        tx,
      );
    });
    const report = await rightsAt(db, {
      userId: personId,
      at: new Date(),
    });
    expect(report.incomplete).toBe(true);
  });
});
