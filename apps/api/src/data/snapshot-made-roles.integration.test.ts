/**
 * A made role in a base's snapshot (ADR 0128): it travels by its name and
 * what it gives, comes back as the role of that name and those acts where
 * the base lands, and a person whose role finds none there is given
 * nothing of the new base, so that nobody sees more of it than of the old.
 */
import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DiskStore } from "../files/index.js";
import { createTestDatabase } from "../test-database.js";
import { withAudit } from "./audit-context.js";
import { importBaseSnapshot } from "./base-snapshot.js";
import { createMadeRole, updateMadeRole } from "./made-roles.js";
import { insertBase, insertTable } from "./schema-ops.js";
import { snapshotOf } from "./snapshot.test-helpers.js";

const suffix = randomBytes(6).toString("hex");

describe("a made role in a snapshot", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let files: DiskStore;
  const ids = { owner: "", cy: "", dee: "", base: "", table: "", made: "" };

  beforeAll(async () => {
    const created = await createTestDatabase("snapshot-made-roles");
    db = created.db;
    close = created.close;
    files = new DiskStore(await mkdtemp(join(tmpdir(), "anygriddb-files-")));
    const people = await db
      .insertInto("users")
      .values(
        ["owner", "cy", "dee"].map((who) => ({
          email: `${who}-${suffix}@example.com`,
          displayName: who,
        })),
      )
      .returning("id")
      .execute();
    [ids.owner, ids.cy, ids.dee] = people.map((person) => person.id) as [
      string,
      string,
      string,
    ];
    ids.made = (
      await createMadeRole(db, ids.owner, {
        name: "Reviewer",
        permissions: ["rows.read", "rows.comment"],
      })
    ).id;
    ids.base = (await insertBase(db, ids.owner, { name: "Dossiers" })).id;
    ids.table = (
      await insertTable(db, ids.owner, {
        baseId: ids.base,
        name: "Docs",
        columns: [{ name: "name", label: "Name", fieldType: "text" }],
      })
    ).id;
    // Cy reviews the base; Dee edits it, and only reviews its table.
    await withAudit(db, { userId: ids.owner }, (tx) =>
      tx
        .insertInto("attributions")
        .values([
          {
            userId: ids.cy,
            madeRoleId: ids.made,
            scope: "base",
            scopeId: ids.base,
          },
          {
            userId: ids.dee,
            role: "editor",
            scope: "base",
            scopeId: ids.base,
          },
          {
            userId: ids.dee,
            madeRoleId: ids.made,
            scope: "table",
            scopeId: ids.table,
          },
        ])
        .execute(),
    );
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  async function copied() {
    const written = await snapshotOf(db, files, ids.base, { withData: true });
    try {
      return await importBaseSnapshot(db, files, ids.owner, written.snapshot, {
        restoreMembers: true,
        readLines: written.readLines,
        maxRows: 1_000,
      });
    } finally {
      await written.close();
    }
  }

  async function heldIn(baseId: string) {
    const tables = await db
      .selectFrom("dataTables")
      .select("id")
      .where("baseId", "=", baseId)
      .execute();
    return db
      .selectFrom("attributions")
      .select(["userId", "role", "madeRoleId", "scope"])
      .where("scopeId", "in", [baseId, ...tables.map((table) => table.id)])
      .where("userId", "<>", ids.owner)
      .orderBy("userId")
      .orderBy("scope")
      .execute();
  }

  it("carries it by its name and acts, and gives it back here", async () => {
    const written = await snapshotOf(db, files, ids.base, { withData: true });
    await written.close();
    const reviewer = {
      name: "Reviewer",
      permissions: ["rows.read", "rows.comment"],
    };
    expect(written.snapshot.members).toEqual(
      expect.arrayContaining([
        { email: `cy-${suffix}@example.com`, role: reviewer },
        { email: `dee-${suffix}@example.com`, role: "editor" },
      ]),
    );
    expect(written.snapshot.tables[0]?.access).toEqual([
      { email: `dee-${suffix}@example.com`, role: reviewer },
    ]);
    const imported = await copied();
    expect(imported.report).toMatchObject({
      members: 2,
      membersRoleMissing: 0,
    });
    const held = await heldIn(imported.baseId);
    expect(held).toEqual(
      expect.arrayContaining([
        { userId: ids.cy, role: null, madeRoleId: ids.made, scope: "base" },
        { userId: ids.dee, role: "editor", madeRoleId: null, scope: "base" },
        { userId: ids.dee, role: null, madeRoleId: ids.made, scope: "table" },
      ]),
    );
    expect(held).toHaveLength(3);
  });

  it("gives nothing to whoever holds a role that finds no match", async () => {
    const written = await snapshotOf(db, files, ids.base, { withData: true });
    // Since the copy, the role here gives more: it is no longer the same.
    await updateMadeRole(db, ids.owner, {
      id: ids.made,
      name: "Reviewer",
      permissions: ["rows.read", "rows.comment", "rows.write"],
    });
    const imported = await importBaseSnapshot(
      db,
      files,
      ids.owner,
      written.snapshot,
      { restoreMembers: true, readLines: written.readLines, maxRows: 1_000 },
    ).finally(() => written.close());
    // Cy's role, and Dee's on the table, would give more: neither comes
    // back, and Dee does not get the base either.
    expect(imported.report).toMatchObject({
      members: 0,
      membersRoleMissing: 2,
    });
    expect(await heldIn(imported.baseId)).toEqual([]);
  });
});
