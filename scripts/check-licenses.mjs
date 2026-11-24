#!/usr/bin/env node
/**
 * Checks that every dependency states a license the project takes
 * (OPEN_SOURCE_POLICY.md): one the OSI approves, under which AnyGridDB can
 * be shipped as AGPL-3.0-or-later. It reads what pnpm installed for every
 * workspace package, what the product ships and what only builds or tests
 * it alike. A package that states no license, or one that is not in the
 * list below, is refused: look the license up on
 * https://opensource.org/licenses first, then add it here.
 * Exits 1 with one line per problem.
 */
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/** The SPDX identifiers the tree uses, each approved by the OSI. */
export const ALLOWED = new Set([
  "0BSD",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "BlueOak-1.0.0",
  "ISC",
  "LGPL-3.0-or-later",
  "MIT",
  "MIT-0",
  "MPL-2.0",
  "OFL-1.1",
  "Python-2.0",
  "Unlicense",
  "Zlib",
]);

/**
 * Packages taken under a license outside the list, each for a reason
 * OPEN_SOURCE_POLICY.md gives. The license is named: under another one,
 * the package is refused again.
 */
export const EXCEPTIONS = new Map([
  // Browser support data that the build tools read, and that is never
  // shipped. CC-BY-4.0 is a license for data, which the OSI does not review.
  ["caniuse-lite", "CC-BY-4.0"],
]);

/**
 * Whether a license expression can be taken: one identifier of the list,
 * every part of an `AND`, or one side of an `OR`, which is then the
 * license elected.
 */
export function allowed(expression) {
  const trimmed = expression.trim();
  const text =
    trimmed.startsWith("(") && trimmed.endsWith(")")
      ? trimmed.slice(1, -1)
      : trimmed;
  return text
    .split(" OR ")
    .some((choice) =>
      choice.split(" AND ").every((id) => ALLOWED.has(id.trim())),
    );
}

/**
 * One line per package whose license is refused, from what
 * `pnpm licenses list --json` prints: packages by license expression.
 */
export function refusals(byLicense) {
  const problems = [];
  for (const [expression, packages] of Object.entries(byLicense)) {
    if (allowed(expression)) continue;
    for (const name of new Set(packages.map((item) => item.name))) {
      if (EXCEPTIONS.get(name) === expression) continue;
      problems.push(
        expression === "Unknown"
          ? `${name}: states no license`
          : `${name}: ${expression} is not a license the project takes`,
      );
    }
  }
  return problems.sort((a, b) => a.localeCompare(b, "en"));
}

function main() {
  const printed = execFileSync(
    "pnpm", // NOSONAR: a check run with the developer's own tools
    ["licenses", "list", "--recursive", "--json"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  let byLicense;
  try {
    byLicense = JSON.parse(printed);
  } catch {
    console.error("pnpm listed no license: run `pnpm install` first.");
    return 1;
  }
  const problems = refusals(byLicense);
  for (const problem of problems) console.error(problem);
  if (problems.length > 0) {
    console.error(
      "\nA dependency's license must be OSI-approved (OPEN_SOURCE_POLICY.md): scripts/check-licenses.mjs has the list.",
    );
    return 1;
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = main();
}
