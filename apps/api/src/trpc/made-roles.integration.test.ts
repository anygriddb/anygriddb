/**
 * Roles an administrator makes of the permissions of a base (ROADMAP
 * #111, ADR 0128): made in Administration, given on a base as the four
 * are, giving what they hold and nothing else, never given beyond the
 * giver's own, and changed for everyone who holds them at once.
 */
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminBench } from "./admin-bench.test-helpers.js";
import {
  enrollTotp,
  errorCode,
  joinBase,
  signUpProved,
  type TestBrowser,
} from "./caller.test-helpers.js";

const PASSWORD = "correct horse battery staple";

describe("made roles", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let admin: TestBrowser;
  let owner: TestBrowser;
  let member: TestBrowser;
  let steward: TestBrowser;
  const ids = {
    owner: "",
    member: "",
    steward: "",
    base: "",
    table: "",
    reviewer: "",
    keeper: "",
    row: "",
  };
  const { browser, account, start } = adminBench("made-roles", PASSWORD);

  beforeAll(async () => {
    const bench = await start();
    ({ db, close, admin } = bench);
    owner = browser();
    ids.owner = await signUpProved(owner, db, account("owner"));
    await enrollTotp(owner);
    ids.base = (await owner.call().catalog.createBase({ name: "Lab" })).id;
    ids.table = (
      await owner.call().catalog.createTable({
        baseId: ids.base,
        name: "Samples",
        columns: [{ name: "ref", label: "Ref", fieldType: "text" }],
      })
    ).id;
    ids.row = (
      await owner
        .call()
        .rows.insert({ tableId: ids.table, values: { ref: "A" } })
    ).id;
    member = browser();
    ids.member = await signUpProved(member, db, account("member"));
    steward = browser();
    ids.steward = await signUpProved(steward, db, account("steward"));
    // A made role that lets someone give access asks a second factor of
    // them, as an owner's does (ADR 0043).
    await enrollTotp(steward);
    for (const userId of [ids.member, ids.steward]) {
      await joinBase(db, { baseId: ids.base, userId, role: "viewer" });
    }
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  it("are made by an administrator alone, read first, each name once", async () => {
    expect(
      await errorCode(
        owner.call().admin.roles.create({
          name: "Reviewer",
          permissions: ["rows.read", "rows.comment"],
        }),
      ),
    ).toBe("access_denied");
    ids.reviewer = (
      await admin.call().admin.roles.create({
        name: "Reviewer",
        permissions: ["rows.read", "rows.comment"],
      })
    ).id;
    ids.keeper = (
      await admin.call().admin.roles.create({
        name: "Keeper",
        // Reaching by a token too: so it gives a viewer what one holds.
        permissions: [
          "rows.read",
          "data.export",
          "api.access",
          "members.manage",
        ],
      })
    ).id;
    expect(
      await errorCode(
        admin.call().admin.roles.create({
          name: "reviewer",
          permissions: ["rows.read"],
        }),
      ),
    ).toBe("role_name_taken");
    expect(
      await errorCode(
        admin.call().admin.roles.create({
          name: "Owner",
          permissions: ["rows.read"],
        }),
      ),
    ).toBe("role_name_taken");
    expect(
      await errorCode(
        admin.call().admin.roles.create({
          name: "Blind",
          permissions: ["rows.write"],
        }),
      ),
    ).toBe("invalid_permissions");
    const listed = await admin.call().admin.roles.list();
    expect(listed.shipped.map((role) => role.role)).toEqual([
      "owner",
      "editor",
      "commenter",
      "viewer",
    ]);
    expect(listed.made.map((role) => [role.name, role.holders])).toEqual([
      ["Keeper", 0],
      ["Reviewer", 0],
    ]);
    // Who manages a base reads them, to give them.
    expect(
      (await owner.call().catalog.madeRoles()).roles.map((role) => role.name),
    ).toEqual(["Keeper", "Reviewer"]);
  });

  it("give what they hold on a base, and nothing else", async () => {
    await owner.call().catalog.grant({
      baseId: ids.base,
      email: account("member").email,
      role: ids.reviewer,
    });
    const api = member.call();
    expect(
      (await api.rows.read({ tableId: ids.table, limit: 10 })).rows,
    ).toHaveLength(1);
    await api.rows.addComment({
      tableId: ids.table,
      rowId: ids.row,
      body: "Seen",
    });
    expect(
      await errorCode(
        api.rows.insert({ tableId: ids.table, values: { ref: "B" } }),
      ),
    ).toBe("access_denied");
    // A viewer exports; this role does not.
    expect(
      await errorCode(
        api.jobs.startExport({ tableId: ids.table, format: "csv" }),
      ),
    ).toBe("access_denied");
    const listed = await owner.call().catalog.members({ baseId: ids.base });
    const held = listed.find((person) => person.userId === ids.member);
    expect(held?.given).toBe(ids.reviewer);
    expect(held?.role).toMatchObject({
      role: null,
      made: [{ id: ids.reviewer, name: "Reviewer" }],
    });
  });

  it("change for everyone who holds them, at once", async () => {
    await admin.call().admin.roles.update({
      id: ids.reviewer,
      name: "Reviewer",
      permissions: ["rows.read", "rows.comment", "rows.write"],
    });
    await member
      .call()
      .rows.insert({ tableId: ids.table, values: { ref: "B" } });
    expect(
      (await member.call().rows.read({ tableId: ids.table, limit: 10 })).rows,
    ).toHaveLength(2);
  });

  it("are given by nobody beyond what they hold", async () => {
    await owner.call().catalog.grant({
      baseId: ids.base,
      email: account("steward").email,
      role: ids.keeper,
    });
    const api = steward.call().catalog;
    // Keeper gives members, not comments: Reviewer is beyond it.
    expect(
      await errorCode(
        api.grant({
          baseId: ids.base,
          email: account("member").email,
          role: ids.reviewer,
        }),
      ),
    ).toBe("role_beyond_reach");
    expect(
      await errorCode(
        api.grant({
          baseId: ids.base,
          email: account("member").email,
          role: "owner",
        }),
      ),
    ).toBe("role_beyond_reach");
    // Nor does it touch a role beyond its own: the owner's stays.
    expect(
      await errorCode(
        api.grant({
          baseId: ids.base,
          email: account("owner").email,
          role: "viewer",
        }),
      ),
    ).toBe("role_beyond_reach");
    expect(
      await errorCode(api.revoke({ baseId: ids.base, userId: ids.owner })),
    ).toBe("role_beyond_reach");
    // A viewer gives what Keeper holds and no more.
    await api.invite({
      baseId: ids.base,
      email: `guest-${ids.base.slice(0, 8)}@example.org`,
      role: "viewer",
    });
    expect(
      await errorCode(
        api.invite({
          baseId: ids.base,
          email: `other-${ids.base.slice(0, 8)}@example.org`,
          role: "editor",
        }),
      ),
    ).toBe("role_beyond_reach");
    // Nor takes back an invitation an owner sent with a wider role.
    await owner.call().catalog.invite({
      baseId: ids.base,
      email: `editor-${ids.base.slice(0, 8)}@example.org`,
      role: "editor",
    });
    const waiting = await api.invitations({ baseId: ids.base });
    const wider = waiting.invitations.find((item) => item.role === "editor");
    expect(
      await errorCode(
        api.revokeInvitation({
          baseId: ids.base,
          invitationId: wider?.id ?? "",
        }),
      ),
    ).toBe("role_beyond_reach");
  });

  it("go only once nobody holds them, nor an invitation waits", async () => {
    expect(
      await errorCode(admin.call().admin.roles.delete({ id: ids.reviewer })),
    ).toBe("role_in_use");
    await owner.call().catalog.grant({
      baseId: ids.base,
      email: account("member").email,
      role: "viewer",
    });
    await admin.call().admin.roles.delete({ id: ids.reviewer });
    expect(
      (await admin.call().admin.roles.list()).made.map((role) => role.name),
    ).toEqual(["Keeper"]);
    expect(
      await errorCode(
        owner.call().catalog.grant({
          baseId: ids.base,
          email: account("member").email,
          role: ids.reviewer,
        }),
      ),
    ).toBe("unknown_role");
  });
});
