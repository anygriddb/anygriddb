/**
 * A role on a base given table by table (ADR 0131): the same role on each
 * table, trashed ones included, and none on the base, so that a rule may
 * narrow one table alone. A base keeps an owner, and a group's role is not
 * a person's own to split.
 */
import { randomBytes } from "node:crypto";
import { effectiveTableRole } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadBindings } from "../auth/access.js";
import {
  addLocalGroupMember,
  createLocalGroup,
  setGroupRole,
} from "../scim/groups.js";
import { createTestDatabase } from "../test-database.js";
import { withAudit } from "./audit-context.js";
import {
  isMember,
  listMembers,
  setMemberRole,
  splitBaseRole,
} from "./members.js";
import { insertBase, insertTable } from "./schema-ops.js";
import { setTableRole } from "./sharing.js";

const suffix = randomBytes(4).toString("hex");

describe("a role on a base given table by table", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let owner = "";
  let editor = "";
  let member = "";
  let baseId = "";
  const tables: string[] = [];

  async function person(name: string): Promise<string> {
    const { id } = await db
      .insertInto("users")
      .values({
        email: `${name}-${suffix}@example.org`,
        displayName: name,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    return id;
  }

  beforeAll(async () => {
    const created = await createTestDatabase("split_base_role");
    db = created.db;
    close = created.close;
    owner = await person("owner");
    editor = await person("editor");
    member = await person("member");
    baseId = (await insertBase(db, owner, { name: `Split ${suffix}` })).id;
    for (const name of ["Visits", "Notes", "Archive"]) {
      tables.push(
        (await insertTable(db, owner, { baseId, name, columns: [] })).id,
      );
    }
    await withAudit(db, { userId: owner }, (tx) =>
      tx
        .updateTable("dataTables")
        .set({ deletedAt: new Date(), deletedBy: owner })
        .where("id", "=", tables[2] ?? "")
        .execute(),
    );
    await setMemberRole(db, owner, { baseId, userId: editor, role: "editor" });
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  it("gives the same role on each table, keeps a wider one, and none on the base", async () => {
    const [visits, notes, archive] = tables as [string, string, string];
    await setTableRole(db, owner, { id: notes, baseId }, editor, "owner");
    await splitBaseRole(db, owner, { baseId, userId: editor });
    const bindings = await loadBindings(db, editor);
    expect(bindings.filter((binding) => binding.scope === "base")).toHaveLength(
      0,
    );
    expect(effectiveTableRole(bindings, visits, baseId)).toBe("editor");
    expect(effectiveTableRole(bindings, notes, baseId)).toBe("owner");
    expect(effectiveTableRole(bindings, archive, baseId)).toBe("editor");
    // Still a member of the base, by their tables.
    const listed = (await listMembers(db, baseId)).find(
      (row) => row.userId === editor,
    );
    expect(listed).toMatchObject({ role: null, tablesOnly: true });
    // And given a role on the base again, at once.
    expect(await isMember(db, baseId, `editor-${suffix}@example.org`)).toBe(
      true,
    );
  });

  it("refuses to leave a base without an owner", async () => {
    await expect(
      splitBaseRole(db, owner, { baseId, userId: owner }),
    ).rejects.toThrow("Invalid owner");
  });

  it("refuses a role a group gives", async () => {
    const group = await createLocalGroup(db, owner, {
      displayName: `Team ${suffix}`,
      description: null,
    });
    await addLocalGroupMember(db, owner, { groupId: group.id, userId: member });
    await setGroupRole(db, owner, {
      baseId,
      groupId: group.id,
      role: "viewer",
    });
    await expect(
      splitBaseRole(db, owner, { baseId, userId: member }),
    ).rejects.toThrow("No role of their own on the base");
  });
});
