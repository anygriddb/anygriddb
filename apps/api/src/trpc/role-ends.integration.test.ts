/**
 * A role given until a date (ADR 0146), through the real router on a
 * migrated database: set and taken away by whoever could give the role,
 * kept when the role changes, giving nothing once its end has come, then
 * removed by the hourly purge as ended, and kept by a copy of the base.
 */
import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiToken } from "../auth/tokens.js";
import { withAudit } from "../data/audit-context.js";
import { importBaseSnapshot } from "../data/base-snapshot.js";
import { createMadeRole } from "../data/made-roles.js";
import { setMemberRole } from "../data/members.js";
import { endRoles } from "../data/role-ends.js";
import { insertBase, insertTable } from "../data/schema-ops.js";
import { snapshotOf } from "../data/snapshot.test-helpers.js";
import { DiskStore } from "../files/index.js";
import { writeSettings } from "../settings.js";
import { createTestDatabase } from "../test-database.js";
import { errorCode, plainBrowsers } from "./caller.test-helpers.js";

const suffix = randomBytes(6).toString("hex");
const DAY = 86_400_000;

describe("a role given until a date", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let files: DiskStore;
  const page = plainBrowsers(() => db)();
  const ids = { owner: "", nina: "", lola: "" };
  const tokens = { owner: "", nina: "", lola: "" };
  let baseId = "";
  let tableId = "";

  const as = (who: keyof typeof tokens) =>
    page.call({ authorization: `Bearer ${tokens[who]}` });
  const end = (who: keyof typeof ids, endsAt: string | null) =>
    as("owner").catalog.setRoleEnd({
      scope: "base",
      scopeId: baseId,
      userId: ids[who],
      endsAt,
    });
  const memberEnd = async (who: keyof typeof ids) =>
    (await as("owner").catalog.members({ baseId })).find(
      (member) => member.userId === ids[who],
    )?.endsAt ?? null;
  const reads = (who: keyof typeof tokens) =>
    errorCode(as(who).rows.read({ tableId, limit: 10 }));

  beforeAll(async () => {
    const created = await createTestDatabase("role_ends");
    db = created.db;
    close = created.close;
    files = new DiskStore(await mkdtemp(join(tmpdir(), "role-ends-")));
    for (const name of Object.keys(ids) as Array<keyof typeof ids>) {
      ids[name] = (
        await db
          .insertInto("users")
          .values({ email: `${name}-${suffix}@example.org`, displayName: name })
          .returning("id")
          .executeTakeFirstOrThrow()
      ).id;
      tokens[name] = (
        await createApiToken(db, ids[name], name, { days: 1 })
      ).token;
    }
    await writeSettings(db, ids.owner, { mfaScope: "admins" });
    baseId = (await insertBase(db, ids.owner, { name: "Ward" })).id;
    tableId = (
      await insertTable(db, ids.owner, {
        baseId,
        name: "Patients",
        columns: [{ name: "name", label: "Name", fieldType: "text" }],
      })
    ).id;
    await setMemberRole(db, ids.owner, {
      baseId,
      userId: ids.nina,
      role: "viewer",
    });
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  it("sets an end, lists it, and takes it away", async () => {
    const tomorrow = new Date(Date.now() + DAY).toISOString();
    expect(await errorCode(end("nina", tomorrow))).toBe("ok");
    expect(await memberEnd("nina")).toBe(tomorrow);
    expect(await reads("nina")).toBe("ok");
    expect(await errorCode(end("nina", null))).toBe("ok");
    expect(await memberEnd("nina")).toBeNull();
  });

  it("refuses an end that is past, an owner's, or a role nobody gave", async () => {
    const yesterday = new Date(Date.now() - DAY).toISOString();
    const tomorrow = new Date(Date.now() + DAY).toISOString();
    expect(await errorCode(end("nina", yesterday))).toBe("end_in_past");
    expect(await errorCode(end("owner", tomorrow))).toBe("owner_never_ends");
    expect(await errorCode(end("lola", tomorrow))).toBe("role_not_given");
    // Only someone who could give the role sets its end.
    const lead = await createMadeRole(db, ids.owner, {
      name: `Lead ${suffix}`,
      permissions: ["rows.read", "api.access", "members.manage"],
    });
    await setMemberRole(db, ids.owner, {
      baseId,
      userId: ids.lola,
      role: lead,
    });
    await setMemberRole(db, ids.owner, {
      baseId,
      userId: ids.nina,
      role: "editor",
    });
    expect(
      await errorCode(
        as("lola").catalog.setRoleEnd({
          scope: "base",
          scopeId: baseId,
          userId: ids.nina,
          endsAt: tomorrow,
        }),
      ),
    ).toBe("role_beyond_reach");
  });

  it("keeps the end when the role changes, and drops it for an owner", async () => {
    const tomorrow = new Date(Date.now() + DAY).toISOString();
    await end("nina", tomorrow);
    await as("owner").catalog.grant({
      baseId,
      email: `nina-${suffix}@example.org`,
      role: "viewer",
    });
    expect(await memberEnd("nina")).toBe(tomorrow);
    await as("owner").catalog.grant({
      baseId,
      email: `nina-${suffix}@example.org`,
      role: "owner",
    });
    expect(await memberEnd("nina")).toBeNull();
    await as("owner").catalog.grant({
      baseId,
      email: `nina-${suffix}@example.org`,
      role: "viewer",
    });
  });

  it("is kept by a copy of the base, and an ended one is not given back", async () => {
    const tomorrow = new Date(Date.now() + DAY).toISOString();
    await end("nina", tomorrow);
    const written = await snapshotOf(db, files, baseId, { withData: true });
    try {
      expect(written.snapshot.members).toContainEqual({
        email: `nina-${suffix}@example.org`,
        role: "viewer",
        until: tomorrow,
      });
      const copy = await importBaseSnapshot(
        db,
        files,
        ids.owner,
        written.snapshot,
        { restoreMembers: true, readLines: written.readLines, maxRows: 100 },
      );
      const given = await db
        .selectFrom("attributions")
        .select("endsAt")
        .where("scope", "=", "base")
        .where("scopeId", "=", copy.baseId)
        .where("userId", "=", ids.nina)
        .executeTakeFirst();
      expect(given?.endsAt?.toISOString()).toBe(tomorrow);
    } finally {
      await written.close();
    }
    const ended = {
      ...(await snapshotOf(db, files, baseId, { withData: false })).snapshot,
    };
    ended.members = (ended.members ?? []).map((member) =>
      member.email.startsWith("nina-")
        ? { ...member, until: new Date(Date.now() - DAY).toISOString() }
        : member,
    );
    const late = await importBaseSnapshot(db, files, ids.owner, ended, {
      restoreMembers: true,
      maxRows: 100,
    });
    const none = await db
      .selectFrom("attributions")
      .select("id")
      .where("scopeId", "=", late.baseId)
      .where("userId", "=", ids.nina)
      .execute();
    expect(none).toEqual([]);
  });

  it("gives nothing once it has ended, and goes as ended within the hour", async () => {
    await withAudit(db, { userId: ids.owner, source: "test" }, (tx) =>
      tx
        .updateTable("attributions")
        .set({ endsAt: new Date(Date.now() - 1_000) })
        .where("userId", "=", ids.nina)
        .where("scope", "=", "base")
        .where("scopeId", "=", baseId)
        .execute(),
    );
    expect(await reads("nina")).not.toBe("ok");
    expect(await memberEnd("nina")).toBeNull();
    expect(await endRoles(db)).toBeGreaterThanOrEqual(1);
    const left = await db
      .selectFrom("attributions")
      .select("id")
      .where("userId", "=", ids.nina)
      .where("scopeId", "=", baseId)
      .execute();
    expect(left).toEqual([]);
    // On the trail as ended, under whoever gave it, the role gone.
    const trail = await db
      .selectFrom("auditEvents")
      .select(["source", "userId", "newValue"])
      .where("catalogTable", "=", "attributions")
      .where("source", "=", "ended")
      .execute();
    expect(trail).toContainEqual({
      source: "ended",
      userId: ids.owner,
      newValue: null,
    });
  });
});
