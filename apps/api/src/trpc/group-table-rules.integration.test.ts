/**
 * A group's role on a table, and its field and row rules (ADR 0131),
 * through the real router on a migrated database: one rule binds each
 * member, "me" being each reader; what else reaches a member adds to it;
 * a rule that would narrow nothing is refused.
 */
import { randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApiToken } from "../auth/tokens.js";
import { createMadeRole } from "../data/made-roles.js";
import { setMemberRole } from "../data/members.js";
import { insertBase, insertTable } from "../data/schema-ops.js";
import {
  addLocalGroupMember,
  createLocalGroup,
  getGroup,
} from "../scim/groups.js";
import { writeSettings } from "../settings.js";
import { createTestDatabase } from "../test-database.js";
import { errorCode, plainBrowsers } from "./caller.test-helpers.js";

const suffix = randomBytes(6).toString("hex");

describe("a group's role and rules on a table", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  const page = plainBrowsers(() => db)();
  const ids = { owner: "", nina: "", nate: "", lola: "" };
  const tokens = { owner: "", nina: "", nate: "", lola: "" };
  let baseId = "";
  let tableId = "";
  let groupId = "";

  const as = (who: keyof typeof tokens) =>
    page.call({ authorization: `Bearer ${tokens[who]}` });
  const read = async (who: keyof typeof tokens) => {
    const { rows } = await as(who).rows.read({ tableId, limit: 100 });
    return {
      names: rows.map((row) => String(row.name)).sort(),
      salary: rows.some((row) => "salary" in row),
    };
  };
  const mine = {
    conjunction: "and" as const,
    conditions: [{ column: "carer", op: "has_any_of" as const, value: ["me"] }],
  };

  beforeAll(async () => {
    const created = await createTestDatabase("group_table_rules");
    db = created.db;
    close = created.close;
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
        columns: [
          { name: "name", label: "Name", fieldType: "text" },
          { name: "salary", label: "Salary", fieldType: "number" },
          {
            name: "carer",
            label: "Carer",
            fieldType: "user",
            config: { multiple: true },
          },
        ],
      })
    ).id;
    groupId = (
      await createLocalGroup(db, ids.owner, {
        displayName: `Nurses ${suffix}`,
        description: null,
      })
    ).id;
    for (const userId of [ids.nina, ids.nate]) {
      await addLocalGroupMember(db, ids.owner, { groupId, userId });
    }
    // Its members reach the table, and a person field may name them.
    expect(await errorCode(read("nina"))).not.toBe("ok");
    await as("owner").catalog.setTableRole({
      tableId,
      groupId,
      role: "viewer",
    });
    await as("owner").rows.insertMany({
      tableId,
      rows: [
        { name: "Alba", salary: 1, carer: [ids.nina] },
        { name: "Boris", salary: 2, carer: [ids.nate] },
        { name: "Cora", salary: 3, carer: [ids.nina, ids.nate] },
      ],
    });
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  it("gives the group's members the table, and lists the group beside them", async () => {
    expect(await read("nina")).toEqual({
      names: ["Alba", "Boris", "Cora"],
      salary: true,
    });
    const reach = await as("owner").catalog.tableAccess({ tableId });
    expect(reach.groups).toEqual([
      {
        groupId,
        displayName: `Nurses ${suffix}`,
        members: 2,
        tableRole: "viewer",
        tableGiven: "viewer",
        tableEndsAt: null,
        baseRole: null,
      },
    ]);
    // Its members reach the table by the group's role, none of their own.
    expect(
      reach.people.find((person) => person.userId === ids.nina),
    ).toMatchObject({ tableRole: "viewer", tableGiven: null, baseRole: null });
    // Someone outside the group does not.
    expect(await errorCode(read("lola"))).not.toBe("ok");
  });

  it("narrows each member by the group's rule, 'me' being who reads", async () => {
    await as("owner").catalog.setTableAcl({
      tableId,
      groupId,
      rowFilter: mine,
      columns: [
        { column: "name", access: "read" },
        { column: "carer", access: "read" },
        { column: "salary", access: "hide" },
      ],
    });
    expect(await read("nina")).toEqual({
      names: ["Alba", "Cora"],
      salary: false,
    });
    expect(await read("nate")).toEqual({
      names: ["Boris", "Cora"],
      salary: false,
    });
    const { rules } = await as("owner").catalog.tableAcl({ tableId });
    expect(rules).toEqual([
      {
        groupId,
        rowFilter: mine,
        columns: expect.arrayContaining([
          { column: "salary", access: "hide" },
        ]) as unknown,
      },
    ]);
    const shown = await getGroup(db, groupId);
    expect(shown.tables).toEqual([
      expect.objectContaining({ tableId, role: "viewer", ruled: true }),
    ]);
    // A member's view of the table, as the manager previews it.
    const seen = await as("owner").catalog.viewAs({
      tableId,
      userId: ids.nina,
      limit: 10,
    });
    expect(seen.sample.total).toBe(2);
  });

  it("adds what else reaches a member: their own role on the table, unruled", async () => {
    await as("owner").catalog.setTableRole({
      tableId,
      userId: ids.nate,
      role: "viewer",
    });
    expect(await read("nate")).toEqual({
      names: ["Alba", "Boris", "Cora"],
      salary: true,
    });
    expect(await read("nina")).toEqual({
      names: ["Alba", "Cora"],
      salary: false,
    });
    await as("owner").catalog.setTableRole({
      tableId,
      userId: ids.nate,
      role: null,
    });
    expect((await read("nate")).names).toEqual(["Boris", "Cora"]);
  });

  it("refuses a rule that would narrow nothing, and one about both or nobody", async () => {
    const rule = { tableId, groupId, rowFilter: mine, columns: [] };
    // A group that holds the base reads the table whole.
    await as("owner").catalog.setGroupRole({ baseId, groupId, role: "viewer" });
    expect(await errorCode(as("owner").catalog.setTableAcl(rule))).toBe(
      "rule_needs_table_role",
    );
    await as("owner").catalog.setGroupRole({ baseId, groupId, role: null });
    // A group that manages the table sets the rules, and none binds it.
    await as("owner").catalog.setTableRole({ tableId, groupId, role: "owner" });
    expect(await errorCode(as("owner").catalog.setTableAcl(rule))).toBe(
      "rule_binds_no_manager",
    );
    await as("owner").catalog.setTableRole({
      tableId,
      groupId,
      role: "viewer",
    });
    // A group with no role on the table, or one that is not there.
    const other = (
      await createLocalGroup(db, ids.owner, {
        displayName: `Porters ${suffix}`,
        description: null,
      })
    ).id;
    for (const target of [other, "00000000-0000-4000-8000-0000000000ff"]) {
      expect(
        await errorCode(
          as("owner").catalog.setTableAcl({ ...rule, groupId: target }),
        ),
      ).toBe("rule_needs_table_role");
    }
    expect(
      await errorCode(
        as("owner").catalog.setTableRole({
          tableId,
          groupId: "00000000-0000-4000-8000-0000000000ff",
          role: "viewer",
        }),
      ),
    ).toBe("unknown_group");
    for (const input of [
      { ...rule, userId: ids.nina },
      { tableId, rowFilter: null, columns: [] },
    ]) {
      expect(
        await errorCode(as("owner").catalog.setTableAcl(input as never)),
      ).toBe("BAD_REQUEST");
    }
    // Only one who manages the table's members sets its rules.
    expect(await errorCode(as("nina").catalog.setTableAcl(rule))).not.toBe(
      "ok",
    );
    // The rule held through all of it.
    expect((await read("nina")).names).toEqual(["Alba", "Cora"]);
  });

  it("leaves a role's rules to whoever could give that role", async () => {
    // Lola manages the base's members with less than a viewer holds: she
    // cannot give the nurses' role, so she neither sets nor takes away
    // the rule that narrows it.
    const lead = await createMadeRole(db, ids.owner, {
      name: `Lead ${suffix}`,
      permissions: [
        "rows.read",
        "rows.comment",
        "api.access",
        "members.manage",
      ],
    });
    await setMemberRole(db, ids.owner, {
      baseId,
      userId: ids.lola,
      role: lead,
    });
    const rule = { tableId, groupId, rowFilter: mine, columns: [] };
    const nurses = { tableId, groupId };
    expect(await errorCode(as("lola").catalog.clearTableAcl(nurses))).toBe(
      "role_beyond_reach",
    );
    expect(
      await errorCode(
        as("lola").catalog.setTableAcl({ ...rule, rowFilter: null }),
      ),
    ).toBe("role_beyond_reach");
    expect(
      await errorCode(
        as("lola").catalog.setTableRole({ tableId, groupId, role: null }),
      ),
    ).toBe("role_beyond_reach");
    expect((await read("nina")).names).toEqual(["Alba", "Cora"]);
    // A person's own role on the table, the same.
    await as("owner").catalog.setTableRole({
      tableId,
      userId: ids.nate,
      role: "editor",
    });
    await as("owner").catalog.setTableAcl({
      tableId,
      userId: ids.nate,
      rowFilter: mine,
      columns: [],
    });
    expect(
      await errorCode(
        as("lola").catalog.clearTableAcl({ tableId, userId: ids.nate }),
      ),
    ).toBe("role_beyond_reach");
    await as("owner").catalog.setTableRole({
      tableId,
      userId: ids.nate,
      role: null,
    });
    // A role she could give, she rules: the nurses as readers.
    await as("owner").catalog.setTableRole({
      tableId,
      groupId,
      role: "reader",
    });
    await as("owner").catalog.setTableAcl(rule);
    expect(await errorCode(as("lola").catalog.clearTableAcl(nurses))).toBe(
      "ok",
    );
    expect(await errorCode(as("lola").catalog.setTableAcl(rule))).toBe("ok");
    await as("owner").catalog.setTableRole({
      tableId,
      groupId,
      role: "viewer",
    });
    await as("owner").catalog.setTableAcl(rule);
  });

  it("gives every row back when the rule is cleared, and nothing when the role goes", async () => {
    await as("owner").catalog.clearTableAcl({ tableId, groupId });
    expect(await read("nina")).toEqual({
      names: ["Alba", "Boris", "Cora"],
      salary: true,
    });
    await as("owner").catalog.setTableRole({ tableId, groupId, role: null });
    expect(await errorCode(read("nina"))).not.toBe("ok");
    expect((await as("owner").catalog.tableAccess({ tableId })).groups).toEqual(
      [],
    );
  });
});
