#!/usr/bin/env node
/**
 * Checks the conventions a linter does not see (CONTRIBUTING.md):
 * - files and directories under apps/, packages/, scripts/, docker/, and
 *   docs/ are kebab-case, but for names a tool or a convention imposes;
 * - migrations are `NNNN_snake_case.sql`, numbered from 0000 without a
 *   gap or a repeat;
 * - dependencies are pinned to exact versions.
 * Only files Git tracks are read. Exits 1 with one line per problem.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const SCOPES = ["apps/", "packages/", "scripts/", "docker/", "docs/"];
const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+(-[a-z0-9]+)*)*$/;
/** Names a tool or a widespread convention spells its own way. */
const IMPOSED = new Set(["README.md", "SOURCES.md", "Dockerfile", "LICENSE"]);
const MIGRATIONS = "packages/db/migrations/";
const MIGRATION = /^(\d{4})_[a-z0-9]+(_[a-z0-9]+)*\.sql$/;
const EXACT = /^(\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?|workspace:\*)$/;
const PINNED = ["dependencies", "devDependencies", "optionalDependencies"];

const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
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

const migrations = tracked
  .filter((file) => file.startsWith(MIGRATIONS))
  .map((file) => basename(file))
  .sort();
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

if (problems.length > 0) {
  console.error(problems.join("\n"));
  console.error(
    `\n${problems.length} convention problem(s); see CONTRIBUTING.md.`,
  );
  process.exit(1);
}
console.log("Conventions: file names, migrations, and versions are fine.");
