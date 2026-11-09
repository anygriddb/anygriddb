/**
 * The Kysely types in packages/db match what the migrations build: a
 * migration added without `pnpm --filter @anygriddb/db db:types` fails here.
 * The committed file is formatted by Prettier, so the comparison is too.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createTestDatabase } from "./test-database.js";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../../../", import.meta.url));
const dbPackage = join(root, "packages/db");
const committed = join(dbPackage, "src/types.generated.ts");

/** What `db:types` writes for the database at `url`. */
async function generatedTypes(url: string): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "anygriddb-types-"));
  const file = join(folder, "types.generated.ts");
  try {
    await run(
      join(dbPackage, "node_modules/.bin/kysely-codegen"),
      ["--url", url, "--out-file", file, "--log-level=error"],
      { cwd: dbPackage },
    );
    await run(join(root, "node_modules/.bin/prettier"), [
      "--write",
      "--config",
      join(root, ".prettierrc.json"),
      file,
    ]);
    return await readFile(file, "utf8");
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

describe("generated database types", () => {
  it("match a freshly migrated database", async () => {
    const database = await createTestDatabase("types");
    try {
      expect(await generatedTypes(database.url)).toBe(
        await readFile(committed, "utf8"),
      );
    } finally {
      await database.close();
    }
  });

  it("differ when the schema has a table they do not know", async () => {
    const database = await createTestDatabase("types_drift");
    try {
      await database.pool.query("create table drift_probe (id integer)");
      const generated = await generatedTypes(database.url);
      expect(generated).toContain("DriftProbe");
      expect(generated).not.toBe(await readFile(committed, "utf8"));
    } finally {
      await database.close();
    }
  });
});
