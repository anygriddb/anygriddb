/**
 * Bases in Administration (ROADMAP #22): the bases no active account
 * owns, and a base put in the trash or taken out of it by an
 * administrator who is not one of its members.
 */
import { randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keyRing } from "./auth/key-ring.js";
import { withAudit } from "./data/audit-context.js";
import { grantMember } from "./data/members.js";
import { insertBase } from "./data/schema-ops.js";
import type { Env } from "./env.js";
import { setGroupRole } from "./scim/groups.js";
import { createTestDatabase } from "./test-database.js";
import {
  browserFactory,
  enrollTotp,
  errorCode as code,
  signUpProved,
} from "./trpc/caller.test-helpers.js";

const suffix = randomBytes(6).toString("hex");
const PASSWORD = "correct horse battery staple";

describe("bases in Administration", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let n = 0;
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

  /** A member's account, signed in on its own browser. */
  const member = async (name: string) => {
    n += 1;
    const email = `${name.toLowerCase()}-${String(n)}-${suffix}@example.org`;
    const page = browser();
    const id = await signUpProved(page, db, {
      email,
      displayName: name,
      password: PASSWORD,
    });
    return { id, email, page };
  };
  const disable = (userId: string, disabled = true) =>
    db
      .updateTable("users")
      .set({ disabledAt: disabled ? new Date() : null })
      .where("id", "=", userId)
      .execute();
  const ownerless = async () =>
    (await admin.call().admin.baseOverview.list({ ownerless: true })).bases.map(
      (base) => base.name,
    );
  const count = async () =>
    (await admin.call().admin.baseOverview.ownerlessCount()).count;

  beforeAll(async () => {
    const created = await createTestDatabase("admin_bases");
    db = created.db;
    close = created.close;
    await admin.call().auth.signup({
      email: `admin-${suffix}@example.org`,
      displayName: "Ada Admin",
      password: PASSWORD,
    });
    await enrollTotp(admin);
    // Naming an owner from Administration asks for a proof again
    // (ROADMAP #28): given once here, it stands for these tests.
    await admin.call().admin.stepUp({ password: PASSWORD });
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  it("points out a base once every owner's account is disabled", async () => {
    const olga = await member("Olga");
    const base = await insertBase(db, olga.id, { name: "Ventes" });
    expect(await ownerless()).toEqual([]);
    expect(await count()).toBe(0);

    await disable(olga.id);
    expect(await ownerless()).toEqual(["Ventes"]);
    expect(await count()).toBe(1);
    const { bases } = await admin.call().admin.baseOverview.list({});
    expect(bases.find((item) => item.id === base.id)?.hasLiveOwner).toBe(false);

    // An editor is not an owner: the base still has nobody to manage it.
    const eve = await member("Eve");
    await grantMember(db, olga.id, {
      email: eve.email,
      baseId: base.id,
      role: "editor",
    });
    expect(await ownerless()).toEqual(["Ventes"]);

    // An owner through a group counts, while its account is active.
    const gus = await member("Gus");
    const group = await withAudit(
      db,
      { userId: olga.id, source: "scim" },
      async (tx) => {
        const made = await tx
          .insertInto("groups")
          .values({ displayName: `Leads ${suffix}` })
          .returning("id")
          .executeTakeFirstOrThrow();
        await tx
          .insertInto("groupMembers")
          .values({ groupId: made.id, userId: gus.id })
          .execute();
        return made;
      },
    );
    await setGroupRole(db, olga.id, {
      baseId: base.id,
      groupId: group.id,
      role: "owner",
    });
    expect(await ownerless()).toEqual([]);
    await disable(gus.id);
    expect(await ownerless()).toEqual(["Ventes"]);

    // The administrator names an owner from the base's page.
    await admin.call().admin.setBaseRole({
      userId: eve.id,
      baseId: base.id,
      role: "owner",
    });
    expect(await ownerless()).toEqual([]);
    expect(await count()).toBe(0);
  });

  it("puts any base in the trash and takes it out, without being a member", async () => {
    const olga = await member("Olga");
    const base = await insertBase(db, olga.id, { name: "Chantier" });
    const trashedNames = async () =>
      (await admin.call().admin.baseOverview.trashed()).items.map(
        (item) => `${item.name} by ${String(item.deletedBy)}`,
      );

    await admin.call().admin.baseOverview.trash({ baseId: base.id });
    expect(await trashedNames()).toEqual(["Chantier by Ada Admin"]);
    expect(
      (await admin.call().admin.baseOverview.list({})).bases.map(
        (item) => item.id,
      ),
    ).not.toContain(base.id);
    // Already there: nothing to put in the trash.
    expect(
      await code(admin.call().admin.baseOverview.trash({ baseId: base.id })),
    ).toBe("no_row");

    await admin.call().admin.baseOverview.restore({ baseId: base.id });
    expect(await trashedNames()).toEqual([]);
    expect(
      await code(admin.call().admin.baseOverview.restore({ baseId: base.id })),
    ).toBe("no_row");

    // A base its own owner deleted is seen, and restored, from there too.
    await enrollTotp(olga.page);
    await olga.page.call().catalog.deleteBase({ baseId: base.id });
    expect(await trashedNames()).toEqual(["Chantier by Olga"]);
    await admin.call().admin.baseOverview.restore({ baseId: base.id });
    expect(
      (await olga.page.call().catalog.list()).map((item) => item.id),
    ).toContain(base.id);
  });

  it("refuses everyone but an administrator", async () => {
    const olga = await member("Olga");
    const base = await insertBase(db, olga.id, { name: "Paie" });
    const calls = olga.page.call().admin.baseOverview;
    expect(await code(calls.list({ ownerless: true }))).toBe("access_denied");
    expect(await code(calls.ownerlessCount())).toBe("access_denied");
    expect(await code(calls.trashed())).toBe("access_denied");
    expect(await code(calls.trash({ baseId: base.id }))).toBe("access_denied");
    expect(await code(calls.restore({ baseId: base.id }))).toBe(
      "access_denied",
    );
    expect(
      (await admin.call().admin.baseOverview.list({})).bases.map(
        (item) => item.id,
      ),
    ).toContain(base.id);
  });
});
