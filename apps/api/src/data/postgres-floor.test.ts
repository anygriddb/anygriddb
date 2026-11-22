import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateDb, PostgresTooOld } from "@anygriddb/db";
import type pg from "pg";
import { afterEach, describe, expect, it } from "vitest";

const folders: string[] = [];
afterEach(async () => {
  await Promise.all(
    folders.splice(0).map((folder) => rm(folder, { recursive: true })),
  );
});

async function oneMigration(): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "anygriddb-floor-"));
  folders.push(folder);
  await writeFile(join(folder, "0000_first.sql"), "select 1;");
  return folder;
}

/** A server of that version, and every statement it was sent. */
function serverOf(version: string) {
  const statements: string[] = [];
  const client = {
    query: (text: string) => {
      statements.push(text);
      if (text.includes("server_version_num")) {
        return Promise.resolve({ rows: [{ version }] });
      }
      return Promise.resolve({ rows: [] });
    },
    release: () => undefined,
  };
  const pool = { connect: () => Promise.resolve(client) } as unknown as pg.Pool;
  return { pool, statements };
}

describe("the PostgreSQL an instance runs on", () => {
  it.each(["130022", "140019", "150014", "159999"])(
    "refuses %s before anything else, naming both versions",
    async (version) => {
      const { pool, statements } = serverOf(version);
      const refused = await migrateDb(pool, await oneMigration()).catch(
        (error: unknown) => error as Error,
      );
      expect(refused).toBeInstanceOf(PostgresTooOld);
      expect((refused as Error).message).toContain(
        `${version.slice(0, 2)}.${String(Number(version.slice(2)))}`,
      );
      expect((refused as Error).message).toContain("PostgreSQL 16");
      expect(statements).toHaveLength(1);
    },
  );

  it.each(["160000", "160014", "170010", "180006"])(
    "migrates on %s",
    async (version) => {
      const { pool, statements } = serverOf(version);
      expect(await migrateDb(pool, await oneMigration())).toEqual([
        "0000_first",
      ]);
      expect(statements.some((text) => text.includes("select 1;"))).toBe(true);
    },
  );

  it("refuses a server that does not say its version", async () => {
    const { pool, statements } = serverOf("not a version");
    await expect(migrateDb(pool, await oneMigration())).rejects.toBeInstanceOf(
      PostgresTooOld,
    );
    expect(statements).toHaveLength(1);
  });
});
