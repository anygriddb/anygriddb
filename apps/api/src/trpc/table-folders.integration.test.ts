/**
 * Folders of tables in a base (ROADMAP #4): organisation in the sidebar,
 * no new permission surface.
 */
import { randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withAudit } from "../data/audit-context.js";
import { eraseAccount } from "../data/erasure.js";
import { bindRole } from "../data/members.js";
import type { Env } from "../env.js";
import { createTestDatabase } from "../test-database.js";
import {
  browserFactory,
  enrollTotp,
  errorCode,
  signUpProved,
} from "./caller.test-helpers.js";

const suffix = randomBytes(6).toString("hex");
const PASSWORD = "correct horse battery staple";

describe("table folders", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  const env = {
    AUTH_ENCRYPTION_KEY: randomBytes(32),
    PUBLIC_URL: "https://grid.example.org",
  } as unknown as Env;
  const hub = {
    closeUser: () => 0,
    closeAllBut: () => 0,
    closeSession: () => 0,
  };
  const browser = browserFactory({ db: () => db, env, hub });
  const owner = browser();
  const guest = browser();
  let ownerId = "";
  let guestId = "";
  let baseId = "";
  let otherBaseId = "";
  let tableA = "";
  let tableB = "";

  const newTable = async (name: string, inBase = baseId) =>
    (
      await owner.call().catalog.createTable({
        baseId: inBase,
        name,
        columns: [{ name: "title", label: "Title", fieldType: "text" }],
      })
    ).id;

  const listedBase = async (page = owner) =>
    (await page.call().catalog.list()).find((item) => item.id === baseId);

  /** A role on one table of the base, and on nothing else of it. */
  const grantTable = (userId: string, tableId: string) =>
    withAudit(db, { userId: ownerId, source: "web" }, (tx) =>
      tx
        .insertInto("roleBindings")
        .values({ userId, role: "viewer", scope: "table", scopeId: tableId })
        .execute(),
    );

  beforeAll(async () => {
    const created = await createTestDatabase("table-folders");
    db = created.db;
    close = created.close;
    await owner.call().auth.signup({
      email: `owner-${suffix}@example.org`,
      displayName: "Olive Owner",
      password: PASSWORD,
    });
    await enrollTotp(owner);
    ownerId = (
      await db
        .selectFrom("users")
        .select("id")
        .where("email", "=", `owner-${suffix}@example.org`)
        .executeTakeFirstOrThrow()
    ).id;
    guestId = await signUpProved(guest, db, {
      email: `guest-${suffix}@example.org`,
      displayName: "Gus Guest",
      password: PASSWORD,
    });
    baseId = (await owner.call().catalog.createBase({ name: "Lab" })).id;
    otherBaseId = (await owner.call().catalog.createBase({ name: "Other" })).id;
    tableA = await newTable("Alpha");
    tableB = await newTable("Beta");
  });

  afterAll(async () => {
    await close?.();
  });

  it("creates a folder, moves tables in, dissolves on delete", async () => {
    const folder = await owner.call().catalog.createFolder({
      baseId,
      name: "Sales",
    });
    expect(
      await errorCode(
        owner.call().catalog.createFolder({ baseId, name: "Sales" }),
      ),
    ).toBe("folder_already_exists");

    await owner.call().catalog.moveTableToFolder({
      tableId: tableA,
      folderId: folder.id,
    });
    await owner.call().catalog.moveTableToFolder({
      tableId: tableB,
      folderId: folder.id,
    });
    await owner.call().catalog.reorderFolderTables({
      folderId: folder.id,
      order: [tableB, tableA],
    });

    const base = await listedBase();
    expect(base?.folders.map((item) => item.name)).toEqual(["Sales"]);
    expect(
      base?.tables
        .filter((table) => table.folderId === folder.id)
        .map((table) => table.id),
    ).toEqual([tableB, tableA]);

    await owner.call().catalog.deleteFolder({ folderId: folder.id });
    const baseAfter = await listedBase();
    expect(baseAfter?.folders).toEqual([]);
    expect(baseAfter?.tables.every((table) => table.folderId === null)).toBe(
      true,
    );
  });

  it("refuses a name another folder has, a folder of another base, and a partial order", async () => {
    const first = await owner.call().catalog.createFolder({
      baseId,
      name: "First",
    });
    const second = await owner.call().catalog.createFolder({
      baseId,
      name: "Second",
    });
    expect(
      await errorCode(
        owner.call().catalog.updateFolder({
          folderId: second.id,
          name: "First",
        }),
      ),
    ).toBe("folder_already_exists");

    const elsewhere = await owner.call().catalog.createFolder({
      baseId: otherBaseId,
      name: "Elsewhere",
    });
    expect(
      await errorCode(
        owner.call().catalog.moveTableToFolder({
          tableId: tableA,
          folderId: elsewhere.id,
        }),
      ),
    ).toBe("folder_wrong_base");

    expect(
      await errorCode(
        owner.call().catalog.reorderFolders({ baseId, order: [second.id] }),
      ),
    ).toBe("invalid_order");
    await owner.call().catalog.reorderFolders({
      baseId,
      order: [second.id, first.id],
    });
    expect((await listedBase())?.folders.map((item) => item.name)).toEqual([
      "Second",
      "First",
    ]);

    await owner.call().catalog.deleteFolder({ folderId: first.id });
    await owner.call().catalog.deleteFolder({ folderId: second.id });
  });

  it("leaves folders to those who manage the base", async () => {
    await grantTable(guestId, tableA);
    const folder = await owner.call().catalog.createFolder({
      baseId,
      name: "Owner's",
    });
    for (const attempt of [
      () => guest.call().catalog.createFolder({ baseId, name: "X" }),
      () =>
        guest.call().catalog.updateFolder({ folderId: folder.id, name: "Y" }),
      () => guest.call().catalog.deleteFolder({ folderId: folder.id }),
      () => guest.call().catalog.reorderFolders({ baseId, order: [folder.id] }),
      () =>
        guest.call().catalog.moveTableToFolder({
          tableId: tableA,
          folderId: folder.id,
        }),
    ]) {
      expect(await errorCode(attempt())).toBe("access_denied");
    }
    await owner.call().catalog.deleteFolder({ folderId: folder.id });
  });

  it("shows a reader with one table only the folders that hold it", async () => {
    const hidden = await owner.call().catalog.createFolder({
      baseId,
      name: "Payroll reviews",
    });
    const shared = await owner.call().catalog.createFolder({
      baseId,
      name: "Shared",
    });
    await owner.call().catalog.moveTableToFolder({
      tableId: tableA,
      folderId: shared.id,
    });
    await owner.call().catalog.moveTableToFolder({
      tableId: tableB,
      folderId: hidden.id,
    });

    const seen = await listedBase(guest);
    expect(seen?.tables.map((table) => table.id)).toEqual([tableA]);
    expect(seen?.folders.map((item) => item.name)).toEqual(["Shared"]);
    expect((await listedBase())?.folders.map((item) => item.name)).toEqual([
      "Payroll reviews",
      "Shared",
    ]);

    await owner.call().catalog.deleteFolder({ folderId: hidden.id });
    await owner.call().catalog.deleteFolder({ folderId: shared.id });
  });

  it("brings a table back at the root when its folder went while it was in the trash", async () => {
    const folder = await owner.call().catalog.createFolder({
      baseId,
      name: "Archive",
    });
    const gone = await newTable("Gamma");
    await owner.call().catalog.moveTableToFolder({
      tableId: gone,
      folderId: folder.id,
    });
    await owner.call().catalog.deleteTable({ tableId: gone });
    await owner.call().catalog.deleteFolder({ folderId: folder.id });
    await owner.call().catalog.restore({ kind: "table", id: gone });

    const table = (await listedBase())?.tables.find((item) => item.id === gone);
    expect(table?.folderId).toBeNull();
  });

  it("erases an account that deleted a folder", async () => {
    const editor = browser();
    const editorId = await signUpProved(editor, db, {
      email: `editor-${suffix}@example.org`,
      displayName: "Eddie Editor",
      password: PASSWORD,
    });
    await enrollTotp(editor);
    await withAudit(db, { userId: ownerId, source: "web" }, (tx) =>
      bindRole(tx, editorId, "owner", baseId),
    );
    const folder = await editor.call().catalog.createFolder({
      baseId,
      name: "Drafts",
    });
    await editor.call().catalog.deleteFolder({ folderId: folder.id });

    await eraseAccount(db, editorId);
    const left = await db
      .selectFrom("users")
      .select("id")
      .where("id", "=", editorId)
      .executeTakeFirst();
    expect(left).toBeUndefined();
  });
});
