import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { PathAllowList } from "./path-allow-list.js";
import { checkSqlite, connectSqlite } from "./sqlite.js";
import { introspectSqlite } from "./sqlite-schema.js";

describe("sqlite source", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function accessFor(dir: string) {
    return { paths: new PathAllowList(dir), allowMemory: false };
  }

  function fileDb(): { path: string; access: ReturnType<typeof accessFor> } {
    const dir = mkdtempSync(join(tmpdir(), "ag-sqlite-"));
    dirs.push(dir);
    const file = join(dir, "lab.sqlite");
    const db = new DatabaseSync(file);
    db.exec(`
      create table people (
        id integer primary key,
        name text not null,
        score real
      );
      insert into people (name, score) values ('Ada', 10.5), ('Gus', 7);
    `);
    db.close();
    return { path: file, access: accessFor(dir) };
  }

  const connection = (database: string) => ({
    engine: "sqlite" as const,
    host: "localhost",
    port: 1,
    database,
    username: "",
    password: "",
    tlsCa: null,
    queryTimeoutMs: 5_000,
  });

  it("checks a file and reports its version", async () => {
    const { path, access } = fileDb();
    const check = await checkSqlite(connection(path), access);
    expect(check.serverVersion).toMatch(/^\d+\.\d+/);
  });

  it("introspects tables, keys, and columns", async () => {
    const { path, access } = fileDb();
    const tables = await introspectSqlite(connection(path), access);
    expect(tables).toHaveLength(1);
    expect(tables[0]).toMatchObject({
      schema: "main",
      name: "people",
      primaryKey: ["id"],
    });
    expect(tables[0]?.columns.map((column) => column.name)).toEqual([
      "id",
      "name",
      "score",
    ]);
  });

  it("runs a select through the opened handle", () => {
    const { path, access } = fileDb();
    const { db, serverVersion } = connectSqlite(connection(path), access);
    expect(serverVersion).toBeTruthy();
    const rows = db
      .prepare("select name from people order by id")
      .all() as Array<{ name: string }>;
    expect(rows.map((row) => row.name)).toEqual(["Ada", "Gus"]);
    db.close();
  });
});
