/**
 * Local groups and effective rights (ROADMAP #27, #29; ADR 0070): create a
 * group in Administration, give it a base role, and read the resolved role
 * on screen the same way the engine would.
 */
import { randomBytes } from "node:crypto";
import { roleFor } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keyRing } from "./auth/key-ring.js";
import { loadBindings } from "./auth/access.js";
import { withAudit } from "./data/audit-context.js";
import { setTableAcl } from "./data/acl.js";
import { grantMember } from "./data/members.js";
import { setTableRole } from "./data/sharing.js";
import { insertBase, insertTable } from "./data/schema-ops.js";
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

describe("local groups and effective rights", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let adminId = "";
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

  const member = async (name: string) => {
    n += 1;
    const email = `${name.toLowerCase()}-${String(n)}-${suffix}@example.org`;
    const page = browser();
    const id = await signUpProved(page, db, {
      email,
      displayName: name,
      password: PASSWORD,
    });
    return { email, id, page };
  };

  beforeAll(async () => {
    const created = await createTestDatabase("admin-groups");
    db = created.db;
    close = created.close;
    await admin.signUpFirst({
      email: `admin-${suffix}@example.org`,
      displayName: "Ada Admin",
      password: PASSWORD,
    });
    await enrollTotp(admin);
    // Giving a group a base role asks for a proof again (ROADMAP #28).
    await admin.call().admin.stepUp({ password: PASSWORD });
    adminId =
      (
        await db
          .selectFrom("users")
          .select("id")
          .where("email", "=", `admin-${suffix}@example.org`)
          .executeTakeFirst()
      )?.id ?? "";
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  it("creates a local group, members get its base role, SCIM cannot change it", async () => {
    const person = await member("Member");
    const base = await insertBase(db, adminId, {
      name: `Finance ${suffix}`,
    });
    const table = await insertTable(db, adminId, {
      baseId: base.id,
      name: "Invoices",
      columns: [{ name: "title", fieldType: "text", label: "Title" }],
    });

    const created = await admin.call().admin.groups.create({
      displayName: `Controllers ${suffix}`,
      description: "Local finance team",
    });
    expect(
      await code(
        admin.call().admin.groups.create({
          displayName: `controllers ${suffix}`,
        }),
      ),
    ).toBe("group_already_exists");

    await admin.call().admin.groups.addMember({
      groupId: created.id,
      userId: person.id,
    });
    await admin.call().admin.groups.setBaseRole({
      groupId: created.id,
      baseId: base.id,
      role: "editor",
    });

    const detail = await admin.call().admin.groups.get({ groupId: created.id });
    expect(detail).toMatchObject({
      id: created.id,
      displayName: `Controllers ${suffix}`,
      description: "Local finance team",
      provider: null,
      members: [
        expect.objectContaining({
          userId: person.id,
          email: person.email,
        }),
      ],
      roles: [
        { baseId: base.id, baseName: `Finance ${suffix}`, role: "editor" },
      ],
    });

    expect(roleFor(await loadBindings(db, person.id), "base", base.id)).toBe(
      "editor",
    );

    const scimGroup = await withAudit(
      db,
      { userId: adminId, source: "scim" },
      async (tx) =>
        tx
          .insertInto("groups")
          .values({
            displayName: `IdP ${suffix}`,
            provider: "scim",
            externalId: `ext-${suffix}`,
          })
          .returning("id")
          .executeTakeFirstOrThrow(),
    );
    expect(
      await code(
        admin.call().admin.groups.addMember({
          groupId: scimGroup.id,
          userId: person.id,
        }),
      ),
    ).toBe("group_provisioned");
    expect(
      await code(admin.call().admin.groups.delete({ groupId: scimGroup.id })),
    ).toBe("group_provisioned");

    await grantMember(db, adminId, {
      baseId: base.id,
      email: person.email,
      role: "owner",
    });
    const rights = await admin.call().admin.access.effective({
      userId: person.id,
      baseId: base.id,
    });
    expect(rights).toMatchObject({
      baseId: base.id,
      role: "owner",
      // Their own role, then the group's they hold too.
      origins: [
        { scope: "base", role: "owner", group: null, endsAt: null },
        {
          scope: "base",
          role: "editor",
          group: { id: created.id, name: `Controllers ${suffix}` },
        },
      ],
    });
    expect(rights.tables).toContainEqual(
      expect.objectContaining({
        tableId: table.id,
        tableName: "Invoices",
        role: "owner",
        overridden: false,
        narrowed: null,
      }),
    );

    await admin.call().admin.removeBaseRole({
      userId: person.id,
      baseId: base.id,
    });
    const viaGroup = await admin.call().admin.access.effective({
      userId: person.id,
      baseId: base.id,
    });
    expect(viaGroup).toMatchObject({
      role: "editor",
      origins: [
        {
          role: "editor",
          group: { id: created.id, name: `Controllers ${suffix}` },
        },
      ],
    });
    expect(
      viaGroup.permissions.find((one) => one.permission === "rows.write"),
    ).toEqual({ permission: "rows.write", from: [0] });

    await setGroupRole(db, adminId, {
      baseId: base.id,
      groupId: created.id,
      role: null,
    });
    expect(
      (
        await admin.call().admin.access.effective({
          userId: person.id,
          baseId: base.id,
        })
      ).role,
    ).toBeNull();

    await admin.call().admin.groups.delete({ groupId: created.id });
    expect(
      await code(admin.call().admin.groups.get({ groupId: created.id })),
    ).toBe("unknown_group");
  });

  it("says each permission's origins, a table's own and its rule, and leaves an ended one out", async () => {
    const person = await member("Reader");
    const base = await insertBase(db, adminId, { name: `Sales ${suffix}` });
    const table = await insertTable(db, adminId, {
      baseId: base.id,
      name: "Orders",
      columns: [{ name: "title", fieldType: "text", label: "Title" }],
    });
    const group = await admin.call().admin.groups.create({
      displayName: `Auditors ${suffix}`,
    });
    await admin.call().admin.groups.addMember({
      groupId: group.id,
      userId: person.id,
    });
    // A rule is set on their own role on the table; the group is given
    // the base after, and reads it whole.
    await setTableRole(
      db,
      adminId,
      { id: table.id, baseId: base.id },
      person.id,
      "editor",
    );
    await setTableAcl(db, adminId, {
      tableId: table.id,
      userId: person.id,
      rowFilter: {
        conjunction: "and",
        conditions: [{ column: "title", op: "is", value: "mine" }],
      },
      columns: [],
    });
    await admin.call().admin.groups.setBaseRole({
      groupId: group.id,
      baseId: base.id,
      role: "viewer",
    });
    const rights = await admin.call().admin.access.effective({
      userId: person.id,
      baseId: base.id,
    });
    expect(rights.role).toBe("viewer");
    const orders = rights.tables.find((one) => one.tableId === table.id);
    expect(orders).toMatchObject({
      role: "editor",
      overridden: true,
      origins: [
        { scope: "base", role: "viewer", narrows: false },
        { scope: "table", role: "editor", group: null, narrows: true },
      ],
      // The group's viewer reads every row: only writing is narrowed.
      narrowed: null,
    });
    const from = (permission: string) =>
      orders?.permissions.find((one) => one.permission === permission)?.from;
    expect(from("rows.read")).toEqual([0, 1]);
    expect(from("rows.write")).toEqual([1]);
    expect(from("schema.manage")).toBeUndefined();

    // An attribution past its end gives nothing, and is not shown.
    await withAudit(db, { userId: adminId, source: "web" }, (tx) =>
      tx
        .updateTable("attributions")
        .set({ endsAt: new Date(Date.now() - 60_000) })
        .where("groupId", "=", group.id)
        .execute(),
    );
    const after = await admin.call().admin.access.effective({
      userId: person.id,
      baseId: base.id,
    });
    expect(after.role).toBeNull();
    expect(after.origins).toEqual([]);
    expect(after.tables.find((one) => one.tableId === table.id)).toMatchObject({
      role: "editor",
      origins: [{ scope: "table", role: "editor" }],
      narrowed: { rows: true, fields: false },
    });
  });

  it("refuses a person who is not an administrator, and a member whose account is disabled", async () => {
    const outsider = await member("Outsider");
    const group = await admin.call().admin.groups.create({
      displayName: `Closed ${suffix}`,
    });
    const asOutsider = outsider.page.call().admin.groups;
    expect(await code(asOutsider.list())).toBe("access_denied");
    expect(await code(asOutsider.get({ groupId: group.id }))).toBe(
      "access_denied",
    );
    expect(
      await code(asOutsider.create({ displayName: `Mine ${suffix}` })),
    ).toBe("access_denied");
    expect(
      await code(
        asOutsider.addMember({ groupId: group.id, userId: outsider.id }),
      ),
    ).toBe("access_denied");
    expect(
      await code(
        outsider.page.call().admin.access.effective({
          userId: adminId,
          baseId: group.id,
        }),
      ),
    ).toBe("access_denied");

    await admin.call().admin.setDisabled({
      userId: outsider.id,
      disabled: true,
    });
    expect(
      await code(
        admin.call().admin.groups.addMember({
          groupId: group.id,
          userId: outsider.id,
        }),
      ),
    ).toBe("unknown_account");
    expect(
      (await admin.call().admin.groups.get({ groupId: group.id })).members,
    ).toEqual([]);
  });
});
