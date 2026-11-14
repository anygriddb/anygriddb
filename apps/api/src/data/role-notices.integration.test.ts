/**
 * A base's owners are told of every role an administrator gives on it
 * (ROADMAP #91): to a person, at an account's creation, to several from a
 * file, to a group, and to someone added to a group that holds a role.
 */
import { randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keyRing } from "../auth/key-ring.js";
import type { Env } from "../env.js";
import { fakeSmtp } from "../mail.test-helpers.js";
import { createTestDatabase } from "../test-database.js";
import {
  browserFactory,
  enrollTotp,
  signUpProved,
} from "../trpc/caller.test-helpers.js";
import { insertBase } from "./schema-ops.js";

const suffix = randomBytes(6).toString("hex");
const PASSWORD = "correct horse battery staple";

describe("what a base's owners are told of the roles an administrator gives", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let smtp: Awaited<ReturnType<typeof fakeSmtp>>;
  let adminId = "";
  let ownerId = "";
  let baseId = "";
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
  const at = (name: string) => `${name}-${suffix}@example.org`;
  const person = async (name: string) =>
    (
      await db
        .insertInto("users")
        .values({ email: at(name.toLowerCase()), displayName: name })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;
  /** What the owner was told since the last call, oldest first. */
  let seen = 0;
  const told = async (userId = ownerId) => {
    const rows = await db
      .selectFrom("notifications")
      .select(["kind", "actorId", "data"])
      .where("userId", "=", userId)
      .where("kind", "in", ["role_given", "owner_named"])
      .orderBy("createdAt", "asc")
      .orderBy("id", "asc")
      .execute();
    if (userId !== ownerId) return rows;
    const fresh = rows.slice(seen);
    seen = rows.length;
    return fresh;
  };

  beforeAll(async () => {
    const created = await createTestDatabase("rolenotice");
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
    await admin.call().admin.stepUp({ password: PASSWORD });
    adminId = (
      await db
        .selectFrom("users")
        .select("id")
        .where("email", "=", at("admin"))
        .executeTakeFirstOrThrow()
    ).id;
    ownerId = await signUpProved(browser(), db, {
      email: at("owner"),
      displayName: "Olive Owner",
      password: PASSWORD,
    });
    baseId = (await insertBase(db, ownerId, { name: "Ventes" })).id;
  }, 120_000);

  afterAll(async () => {
    await smtp.close();
    await close?.();
  });

  it("tells them of a role given to a person, once", async () => {
    const guest = await person("Gil");
    const give = (role: "viewer" | "editor") =>
      admin.call().admin.setBaseRole({ userId: guest, baseId, role });
    await give("viewer");
    await give("viewer");
    expect(await told()).toEqual([
      {
        kind: "role_given",
        actorId: adminId,
        data: { baseId, base: "Ventes", name: "Gil", role: "viewer" },
      },
    ]);
    // A role changed is a role given.
    await give("editor");
    expect((await told()).map((notice) => notice.data?.role)).toEqual([
      "editor",
    ]);
    // Neither the person who received it nor the administrator is told.
    expect(await told(guest)).toEqual([]);
    expect(await told(adminId)).toEqual([]);
  });

  it("keeps the notice an owner named always had", async () => {
    const heir = await person("Hana");
    await admin
      .call()
      .admin.setBaseRole({ userId: heir, baseId, role: "owner" });
    expect(await told()).toEqual([
      {
        kind: "owner_named",
        actorId: adminId,
        data: { baseId, base: "Ventes", name: "Hana" },
      },
    ]);
    // The new owner is an owner now: the next notices reach them too.
    await admin.call().admin.setBaseRole({
      userId: await person("Ines"),
      baseId,
      role: "commenter",
    });
    expect((await told(heir)).map((notice) => notice.data?.name)).toEqual([
      "Ines",
    ]);
    await told();
  });

  it("tells them of an account created with a role on their base", async () => {
    await admin.call().admin.createAccount({
      email: at("new"),
      displayName: "Noor New",
      admin: false,
      memberships: [{ baseId, role: "editor" }],
    });
    expect(await told()).toEqual([
      {
        kind: "role_given",
        actorId: adminId,
        data: { baseId, base: "Ventes", name: "Noor New", role: "editor" },
      },
    ]);
  });

  it("tells them once of the people a file adds, however many", async () => {
    const file = [
      "email,name,bases",
      `${at("file-a")},File A,Ventes:viewer`,
      `${at("file-b")},File B,Ventes:editor`,
      `${at("file-c")},File C,`,
    ].join("\n");
    const result = await admin.call().admin.people.add({ file });
    expect(result.added).toBe(3);
    expect(result).not.toHaveProperty("given");
    expect(await told()).toEqual([
      {
        kind: "role_given",
        actorId: adminId,
        data: { baseId, base: "Ventes", count: "2" },
      },
    ]);
  });

  it("tells them of a group given a role, and of a member added to it", async () => {
    const { id: groupId } = await admin
      .call()
      .admin.groups.create({ displayName: `Compta ${suffix}` });
    const first = await person("Jo");
    // A member of a group that holds no role yet: nothing to tell.
    await admin.call().admin.groups.addMember({ groupId, userId: first });
    expect(await told()).toEqual([]);

    const give = () =>
      admin
        .call()
        .admin.groups.setBaseRole({ groupId, baseId, role: "editor" });
    await give();
    await give();
    expect(await told()).toEqual([
      {
        kind: "role_given",
        actorId: adminId,
        data: {
          baseId,
          base: "Ventes",
          group: `Compta ${suffix}`,
          role: "editor",
        },
      },
    ]);

    const second = await person("Kim");
    const add = () =>
      admin.call().admin.groups.addMember({ groupId, userId: second });
    await add();
    await add();
    expect(await told()).toEqual([
      {
        kind: "role_given",
        actorId: adminId,
        data: {
          baseId,
          base: "Ventes",
          name: "Kim",
          group: `Compta ${suffix}`,
          role: "editor",
        },
      },
    ]);

    // Taking the role back gives nothing: nothing is told.
    await admin
      .call()
      .admin.groups.setBaseRole({ groupId, baseId, role: null });
    expect(await told()).toEqual([]);
  });

  it("says nothing of what an owner does on their own base", async () => {
    const mine = await insertBase(db, adminId, { name: "Mine" });
    await admin.call().admin.setBaseRole({
      userId: await person("Lou"),
      baseId: mine.id,
      role: "viewer",
    });
    expect(await told(adminId)).toEqual([]);
  });
});
