/**
 * What the conversion to attributions will not keep exactly (ADR 0131),
 * as `ag_rights_review()` reads it: one person of each case on one base,
 * and those it must not name.
 */
import { randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase } from "../test-database.js";
import {
  addLocalGroupMember,
  createLocalGroup,
  setGroupRole,
} from "../scim/groups.js";
import { setTableAcl } from "./acl.js";
import { withAudit } from "./audit-context.js";
import { createMadeRole } from "./made-roles.js";
import { setMemberRole } from "./members.js";
import { listRightsReview } from "./rights-review.js";
import { insertBase, insertTable } from "./schema-ops.js";
import { setTableRole } from "./sharing.js";

const suffix = randomBytes(4).toString("hex");

describe("rights to review before the conversion", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let ownerId = "";
  let baseId = "";
  const tables: { id: string; baseId: string }[] = [];
  const people = new Map<string, string>();

  async function person(name: string): Promise<string> {
    const { id } = await db
      .insertInto("users")
      .values({
        email: `${name.toLowerCase()}-${suffix}@example.org`,
        displayName: name,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    people.set(name, id);
    return id;
  }

  beforeAll(async () => {
    const created = await createTestDatabase("rights_review");
    db = created.db;
    close = created.close;
    ownerId = await person("Owner");
    baseId = (await insertBase(db, ownerId, { name: `Ledger ${suffix}` })).id;
    for (const name of ["Visits", "Notes", "Archive"]) {
      tables.push(
        await insertTable(db, ownerId, { baseId, name, columns: [] }).then(
          ({ id }) => ({ id, baseId }),
        ),
      );
    }
    const [visits, notes, archive] = tables as [
      { id: string; baseId: string },
      { id: string; baseId: string },
      { id: string; baseId: string },
    ];
    // The archive is in the trash: it counts, a restore gives it back.
    await withAudit(db, { userId: ownerId }, (tx) =>
      tx
        .updateTable("dataTables")
        .set({ deletedAt: new Date(), deletedBy: ownerId })
        .where("id", "=", archive.id)
        .execute(),
    );
    const give = (
      userId: string,
      role: Parameters<typeof setMemberRole>[2]["role"],
    ) => setMemberRole(db, ownerId, { baseId, userId, role });

    // (a) A table gives more than the base: nothing to say.
    const wider = await person("Wider");
    await give(wider, "viewer");
    await setTableRole(db, ownerId, visits, wider, "editor");

    // (c) and (f) An editor narrowed to a viewer on one table, and on the
    // trashed one to a commenter.
    const narrowed = await person("Narrowed");
    await give(narrowed, "editor");
    await setTableRole(db, ownerId, visits, narrowed, "viewer");
    await setTableRole(db, ownerId, archive, narrowed, "commenter");

    // (b) A second owner narrowed on a table.
    const manager = await person("Manager");
    await give(manager, "owner");
    await setTableRole(db, ownerId, notes, manager, "viewer");

    // (e) A group's editor role, narrowed by a table's role of one's own.
    const member = await person("Member");
    const group = await createLocalGroup(db, ownerId, {
      displayName: `Clinic ${suffix}`,
      description: null,
    });
    await addLocalGroupMember(db, ownerId, {
      groupId: group.id,
      userId: member,
    });
    await setGroupRole(db, ownerId, {
      baseId,
      groupId: group.id,
      role: "editor",
    });
    await setTableRole(db, ownerId, notes, member, "viewer");

    // (d) A commenter with a row rule.
    const ruled = await person("Ruled");
    await give(ruled, "commenter");
    await setTableAcl(db, ownerId, {
      tableId: visits.id,
      userId: ruled,
      rowFilter: { conjunction: "and", conditions: [] },
      columns: [],
    });

    // (g) A field rule on an owner, where it binds nothing.
    const idle = await person("Idle");
    await give(idle, "owner");
    await setTableAcl(db, ownerId, {
      tableId: notes.id,
      userId: idle,
      rowFilter: null,
      columns: [{ column: "notes", access: "read" }],
    });

    // A role on a table alone, with its rule: it moves as it is.
    const tableOnly = await person("TableOnly");
    await setTableRole(db, ownerId, visits, tableOnly, "editor");
    await setTableAcl(db, ownerId, {
      tableId: visits.id,
      userId: tableOnly,
      rowFilter: { conjunction: "and", conditions: [] },
      columns: [],
    });

    // A made role narrowed by one that holds all it gives and more: (a).
    const reader = await createMadeRole(db, ownerId, {
      name: `Reader ${suffix}`,
      permissions: ["rows.read", "rows.comment"],
    });
    const made = await person("Made");
    await give(made, reader);
    await setTableRole(db, ownerId, notes, made, "commenter");
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  it("names each case once, with what it moves", async () => {
    const review = await listRightsReview(db, { limit: 100, offset: 0 });
    const said = review.lines.map((line) => ({
      who: line.person.name,
      kind: line.kind,
      table: line.table?.name ?? null,
      trashed: line.table?.trashed ?? null,
      permissions: line.permissions,
    }));
    expect(said).toEqual([
      {
        who: "Idle",
        kind: "idle_rule",
        table: "Notes",
        trashed: false,
        permissions: [],
      },
      {
        who: "Manager",
        kind: "manager",
        table: "Notes",
        trashed: false,
        permissions: [
          "rows.comment",
          "rows.write",
          "rows.delete",
          "rows.lock",
          "rows.transition",
          "data.import",
          "publish",
          "views.manage",
          "dashboards.manage",
          "schema.manage",
          "automations.manage",
          "webhooks.manage",
          "members.manage",
          "base.manage",
        ],
      },
      {
        who: "Member",
        kind: "group",
        table: "Notes",
        trashed: false,
        permissions: [
          "rows.comment",
          "rows.write",
          "rows.delete",
          "rows.transition",
          "data.import",
          "publish",
          "views.manage",
        ],
      },
      {
        who: "Narrowed",
        kind: "floor",
        table: null,
        trashed: null,
        permissions: ["rows.read", "data.export", "api.access"],
      },
      {
        who: "Narrowed",
        kind: "base_only",
        table: null,
        trashed: null,
        permissions: ["data.import", "publish"],
      },
      {
        who: "Ruled",
        kind: "ruled",
        table: null,
        trashed: null,
        permissions: [],
      },
    ]);
    expect(review.counts).toEqual({
      manager: 1,
      group: 1,
      ruled: 1,
      floor: 1,
      base_only: 1,
      idle_rule: 1,
    });
    expect(review.total).toBe(6);
  });

  it("names nobody once the narrowing is lifted", async () => {
    const narrowed = people.get("Narrowed") ?? "";
    for (const table of tables) {
      await setTableRole(db, ownerId, table, narrowed, null);
    }
    const review = await listRightsReview(db, { limit: 100, offset: 0 });
    expect(review.lines.map((line) => line.person.name)).not.toContain(
      "Narrowed",
    );
    expect(review.counts.floor).toBe(0);
    expect(review.counts.base_only).toBe(0);
  });

  it("reads a page at a time", async () => {
    const first = await listRightsReview(db, { limit: 1, offset: 0 });
    const second = await listRightsReview(db, { limit: 1, offset: 1 });
    expect(first.lines).toHaveLength(1);
    expect(second.lines).toHaveLength(1);
    expect(first.lines[0]?.person.name).not.toBe(second.lines[0]?.person.name);
    expect(first.total).toBe(second.total);
  });
});
