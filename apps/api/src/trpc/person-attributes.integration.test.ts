/**
 * A person's attributes in a row rule (ADR 0142), through the real router
 * on a migrated database: one group's rule, "ward is the reader's ward",
 * keeps each member to their own ward's rows; a member without a ward, or
 * an attribute the catalogue lost, keeps none; a rule naming an attribute
 * the instance does not know, or with an operator that keeps rows out, is
 * refused.
 */
import { randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keyRing } from "../auth/key-ring.js";
import { createApiToken } from "../auth/tokens.js";
import { setMemberRole } from "../data/members.js";
import { insertBase, insertTable } from "../data/schema-ops.js";
import type { Env } from "../env.js";
import {
  addLocalGroupMember,
  createLocalGroup,
  removeLocalGroupMember,
} from "../scim/groups.js";
import { createTestDatabase } from "../test-database.js";
import {
  browserFactory,
  enrollTotp,
  errorCode,
  plainBrowsers,
} from "./caller.test-helpers.js";

const suffix = randomBytes(6).toString("hex");
const PASSWORD = "correct horse battery staple";

describe("a person's attributes in a row rule", () => {
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
  };
  const admin = browserFactory({ db: () => db, env, hub })();
  const page = plainBrowsers(() => db)();
  const ids = { admin: "", nina: "", nate: "", nils: "" };
  const tokens = { admin: "", nina: "", nate: "", nils: "" };
  let baseId = "";
  let tableId = "";
  let groupId = "";

  const as = (who: keyof typeof tokens) =>
    page.call({ authorization: `Bearer ${tokens[who]}` });
  const names = async (who: keyof typeof tokens) =>
    (await as(who).rows.read({ tableId, limit: 100 })).rows
      .map((row) => String(row.name))
      .sort();
  const byWard = {
    conjunction: "and" as const,
    conditions: [
      { column: "ward", op: "is" as const, value: { attribute: "ward" } },
    ],
  };
  const setWard = (who: "nina" | "nate", values: string[]) =>
    admin.call().admin.attributes.setForAccount({
      userId: ids[who],
      values: { ward: values },
    });

  beforeAll(async () => {
    const created = await createTestDatabase("person_attributes");
    db = created.db;
    close = created.close;
    await admin.signUpFirst({
      email: `admin-${suffix}@example.org`,
      displayName: "Ada Admin",
      password: PASSWORD,
    });
    await enrollTotp(admin);
    await admin.call().admin.stepUp({ password: PASSWORD });
    ids.admin =
      (
        await db
          .selectFrom("users")
          .select("id")
          .where("email", "=", `admin-${suffix}@example.org`)
          .executeTakeFirst()
      )?.id ?? "";
    for (const name of ["nina", "nate", "nils"] as const) {
      ids[name] = (
        await db
          .insertInto("users")
          .values({ email: `${name}-${suffix}@example.org`, displayName: name })
          .returning("id")
          .executeTakeFirstOrThrow()
      ).id;
    }
    for (const name of Object.keys(tokens) as Array<keyof typeof tokens>) {
      tokens[name] = (
        await createApiToken(db, ids[name], name, { days: 1 })
      ).token;
    }
    baseId = (await insertBase(db, ids.admin, { name: "Hospital" })).id;
    tableId = (
      await insertTable(db, ids.admin, {
        baseId,
        name: "Patients",
        columns: [
          { name: "name", label: "Name", fieldType: "text" },
          { name: "ward", label: "Ward", fieldType: "text" },
        ],
      })
    ).id;
    await as("admin").rows.insertMany({
      tableId,
      rows: [
        { name: "Alba", ward: "3" },
        { name: "Boris", ward: "4" },
        { name: "Cora", ward: "3" },
      ],
    });
    groupId = (
      await createLocalGroup(db, ids.admin, {
        displayName: `Nurses ${suffix}`,
        description: null,
      })
    ).id;
    for (const name of ["nina", "nate", "nils"] as const) {
      await addLocalGroupMember(db, ids.admin, { groupId, userId: ids[name] });
    }
    await as("admin").catalog.setTableRole({
      tableId,
      groupId,
      role: "viewer",
    });
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  it("keeps the catalogue, and an account's values, as whoever gives access sets them", async () => {
    await admin.call().admin.attributes.create({
      key: "ward",
      label: "Ward",
      scimField: "department",
    });
    expect(
      await errorCode(
        admin.call().admin.attributes.create({
          key: "ward_two",
          label: "ward",
          scimField: null,
        }),
      ),
    ).toBe("attribute_exists");
    await setWard("nina", ["3"]);
    await setWard("nate", ["4"]);
    expect(
      await admin.call().admin.attributes.ofAccount({ userId: ids.nina }),
    ).toEqual({ values: { ward: ["3"] } });
    expect(
      await errorCode(
        admin.call().admin.attributes.setForAccount({
          userId: ids.nina,
          values: { site: ["North"] },
        }),
      ),
    ).toBe("unknown_attribute");
    // Whoever sets a rule sees the attributes, never anyone's values.
    expect(await as("admin").catalog.personAttributes()).toEqual({
      attributes: [{ key: "ward", label: "Ward" }],
    });
  });

  it("keeps each member to their own ward's rows, and one without a ward to none", async () => {
    await as("admin").catalog.setTableAcl({
      tableId,
      groupId,
      rowFilter: byWard,
      columns: [],
    });
    expect(await names("nina")).toEqual(["Alba", "Cora"]);
    expect(await names("nate")).toEqual(["Boris"]);
    expect(await names("nils")).toEqual([]);
    // Moved to ward 4, or given both, at once.
    await setWard("nina", ["4"]);
    expect(await names("nina")).toEqual(["Boris"]);
    await setWard("nina", ["3", "4"]);
    expect(await names("nina")).toEqual(["Alba", "Boris", "Cora"]);
    // A value taken away keeps no row.
    await setWard("nina", []);
    expect(await names("nina")).toEqual([]);
    await setWard("nina", ["3"]);
  });

  it("refuses a rule naming an attribute the instance does not know, or keeping rows out by one", async () => {
    const rule = (value: unknown, op = "is") => ({
      tableId,
      groupId,
      rowFilter: {
        conjunction: "and" as const,
        conditions: [{ column: "ward", op, value }],
      } as never,
      columns: [],
    });
    expect(
      await errorCode(
        as("admin").catalog.setTableAcl(rule({ attribute: "site" })),
      ),
    ).toBe("unknown_attribute");
    expect(
      await errorCode(
        as("admin").catalog.setTableAcl(rule({ attribute: "ward" }, "is_not")),
      ),
    ).toBe("invalid_filter");
    // A view's filter is no one's access: it takes none.
    const { views } = await as("admin").catalog.views({ tableId });
    const viewId = views[0]?.id ?? "";
    const plain = {
      conjunction: "and" as const,
      conditions: [{ column: "ward", op: "is" as const, value: "3" }],
    };
    expect(
      await errorCode(
        as("admin").catalog.updateView({ viewId, config: { filter: plain } }),
      ),
    ).toBe("ok");
    expect(
      await errorCode(
        as("admin").catalog.updateView({ viewId, config: { filter: byWard } }),
      ),
    ).toBe("invalid_view");
    expect(await names("nina")).toEqual(["Alba", "Cora"]);
  });

  it("tells the base's owners of values a rule reads, and asks an administrator's own a reason", async () => {
    const olga = (
      await db
        .insertInto("users")
        .values({ email: `olga-${suffix}@example.org`, displayName: "Olga" })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;
    await setMemberRole(db, ids.admin, { baseId, userId: olga, role: "owner" });
    const told = async () =>
      (
        await db
          .selectFrom("notifications")
          .select("data")
          .where("userId", "=", olga)
          .where("kind", "=", "role_given")
          .orderBy("createdAt")
          .execute()
      ).map((notice) => notice.data);
    // Nate moved to ward 3: his ward is read by the nurses' rule.
    await setWard("nate", ["3"]);
    expect(await told()).toEqual([
      expect.objectContaining({ baseId, name: "nate", attributes: "Ward" }),
    ]);
    expect((await told())[0]).not.toHaveProperty("reason");
    // The same values again change nothing, and tell nothing.
    await setWard("nate", ["3"]);
    expect(await told()).toHaveLength(1);
    // The administrator's own values, as a nurse: a reason first.
    await addLocalGroupMember(db, ids.admin, { groupId, userId: ids.admin });
    const own = { userId: ids.admin, values: { ward: ["4"] } };
    expect(
      await errorCode(admin.call().admin.attributes.setForAccount(own)),
    ).toBe("reason_required");
    expect(await told()).toHaveLength(1);
    const reason = "Covering ward 4 tonight";
    await admin.call().admin.attributes.setForAccount({ ...own, reason });
    expect((await told())[1]).toMatchObject({ attributes: "Ward", reason });
    const trail = await db
      .selectFrom("auditEvents")
      .select("reason")
      .where("catalogTable", "=", "account_attributes")
      .where("userId", "=", ids.admin)
      .orderBy("occurredAt", "desc")
      .executeTakeFirst();
    expect(trail?.reason).toBe(reason);
    // Values no rule reaches tell no one: Nils's group rule is the only
    // one, and he leaves the group.
    await removeLocalGroupMember(db, ids.admin, { groupId, userId: ids.nils });
    await admin.call().admin.attributes.setForAccount({
      userId: ids.nils,
      values: { ward: ["3"] },
    });
    expect(await told()).toHaveLength(2);
  });

  it("keeps no row once the catalogue loses the attribute", async () => {
    await admin.call().admin.attributes.remove({ key: "ward" });
    expect(await names("nina")).toEqual([]);
    expect(await names("nate")).toEqual([]);
  });
});
