#!/usr/bin/env node
/**
 * Checks the conventions a linter does not see (CONTRIBUTING.md):
 * - files and directories under apps/, packages/, scripts/, docker/, and
 *   docs/ are kebab-case, but for names a tool or a convention imposes;
 * - migrations are `NNNN_snake_case.sql`, numbered from 0000 without a
 *   gap or a repeat; a migration's check is `NNNN_snake_case.check.sql`,
 *   beside it;
 * - dependencies are pinned to exact versions;
 * - the root package.json holds the product's version, in SemVer
 *   (ADR 0048);
 * - no text file holds a line a merge left unresolved
 *   (`conflict-markers.mjs`): Prettier moves such a line into a list, a
 *   table or a quote, where it passes the format check.
 * Only files Git tracks are read. Exits 1 with one line per problem.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { conflictMarkers } from "./conflict-markers.mjs";

const SCOPES = ["apps/", "packages/", "scripts/", "docker/", "docs/"];
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+(-[a-z0-9]+)*)*$/;
/** Names a tool or a widespread convention spells its own way. */
const IMPOSED = new Set(["README.md", "SOURCES.md", "Dockerfile", "LICENSE"]);
const MIGRATIONS = "packages/db/migrations/";
const MIGRATION = /^(\d{4})_[a-z0-9]+(_[a-z0-9]+)*\.sql$/;
const MIGRATION_CHECK = ".check.sql";
const EXACT = /^(\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?|workspace:\*)$/;
const PINNED = ["dependencies", "devDependencies", "optionalDependencies"];
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;

const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }) // NOSONAR: a check run with the developer's own tools
  .split("\0")
  .filter(Boolean);
const problems = [];

for (const path of tracked.filter((file) =>
  SCOPES.some((scope) => file.startsWith(scope)),
)) {
  if (path.startsWith(MIGRATIONS)) continue;
  const parts = path.split("/");
  const name = parts.pop() ?? "";
  for (const directory of parts) {
    if (!KEBAB.test(directory)) {
      problems.push(`${path}: directory "${directory}" is not kebab-case`);
    }
  }
  if (!IMPOSED.has(name) && !KEBAB.test(name.replace(/^\./, ""))) {
    problems.push(`${path}: file name is not kebab-case`);
  }
}

const migrationFiles = tracked
  .filter((file) => file.startsWith(MIGRATIONS))
  .map((file) => basename(file))
  .sort();
const migrations = migrationFiles.filter(
  (name) => !name.endsWith(MIGRATION_CHECK),
);
for (const name of migrationFiles) {
  if (!name.endsWith(MIGRATION_CHECK)) continue;
  const migration = `${name.slice(0, -MIGRATION_CHECK.length)}.sql`;
  if (!migrations.includes(migration)) {
    problems.push(`${MIGRATIONS}${name}: no migration ${migration} beside it`);
  }
}
migrations.forEach((name, index) => {
  const match = MIGRATION.exec(name);
  if (!match) {
    problems.push(`${MIGRATIONS}${name}: expected NNNN_snake_case.sql`);
    return;
  }
  const expected = String(index).padStart(4, "0");
  if (match[1] !== expected) {
    problems.push(
      `${MIGRATIONS}${name}: expected number ${expected} (no gap, no repeat)`,
    );
  }
});

for (const path of tracked.filter(
  (file) => basename(file) === "package.json",
)) {
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  for (const field of PINNED) {
    for (const [name, version] of Object.entries(manifest[field] ?? {})) {
      if (!EXACT.test(String(version))) {
        problems.push(`${path}: ${name} "${version}" is not an exact version`);
      }
    }
  }
}

const TEXT =
  /\.(?:md|mdx|ts|tsx|js|mjs|cjs|json|ya?ml|sql|css|html|sh|po|toml|txt)$/;
for (const path of tracked.filter(
  (file) => TEXT.test(file) && existsSync(file),
)) {
  for (const line of conflictMarkers(readFileSync(path, "utf8"))) {
    problems.push(`${path}:${line}: a merge's conflict marker`);
  }
}

const { version } = JSON.parse(readFileSync("package.json", "utf8"));
if (typeof version !== "string" || !SEMVER.test(version)) {
  problems.push(
    `package.json: version "${version}" is not MAJOR.MINOR.PATCH (the product's version)`,
  );
}

if (problems.length > 0) {
  console.error(problems.join("\n"));
  console.error(
    `\n${problems.length} convention problem(s); see CONTRIBUTING.md.`,
  );
  process.exit(1);
}
console.log("Conventions: file names, migrations, and versions are fine.");
