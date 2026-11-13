/**
 * Folders of tables in a base (ROADMAP #4): organisation in the sidebar,
 * no new permission surface.
 */
import { randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../env.js";
import { createTestDatabase } from "../test-database.js";
import {
  browserFactory,
  enrollTotp,
  errorCode,
} from "./caller.test-helpers.js";

const suffix = randomBytes(6).toString("hex");

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
  let baseId = "";
  let tableA = "";
  let tableB = "";

  beforeAll(async () => {
    const created = await createTestDatabase("table-folders");
    db = created.db;
    close = created.close;
    await owner.call().auth.signup({
      email: `owner-${suffix}@example.org`,
      displayName: "Olive Owner",
      password: "correct horse battery staple",
    });
    await enrollTotp(owner);
    baseId = (await owner.call().catalog.createBase({ name: "Lab" })).id;
    tableA = (
      await owner.call().catalog.createTable({
        baseId,
        name: "Alpha",
        columns: [{ name: "title", label: "Title", fieldType: "text" }],
      })
    ).id;
    tableB = (
      await owner.call().catalog.createTable({
        baseId,
        name: "Beta",
        columns: [{ name: "title", label: "Title", fieldType: "text" }],
      })
    ).id;
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

    const listed = await owner.call().catalog.list();
    const base = listed.find((item) => item.id === baseId);
    expect(base?.folders.map((item) => item.name)).toEqual(["Sales"]);
    expect(
      base?.tables
        .filter((table) => table.folderId === folder.id)
        .map((table) => table.id),
    ).toEqual([tableB, tableA]);

    await owner.call().catalog.deleteFolder({ folderId: folder.id });
    const after = await owner.call().catalog.list();
    const baseAfter = after.find((item) => item.id === baseId);
    expect(baseAfter?.folders).toEqual([]);
    expect(baseAfter?.tables.every((table) => table.folderId === null)).toBe(
      true,
    );
  });
});
