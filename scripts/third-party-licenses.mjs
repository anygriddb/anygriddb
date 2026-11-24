#!/usr/bin/env node
/**
 * Writes what AnyGridDB must hand over with the libraries it ships: one
 * text file naming each of them, its version, its license and the license
 * text its package carries, and a copy of AnyGridDB's own license. The
 * web build puts both where the app serves them, so the image holds them
 * and every instance can show them (`apps/web/components/shell/about-dialog.tsx`).
 *
 * It reads what pnpm installed for what the product ships: the
 * dependencies of the API and of the web app, not the tools that build or
 * test them.
 *
 * Usage: node scripts/third-party-licenses.mjs
 * It writes into `apps/web/public`, which the web build serves.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The files of a package that state its license or its notices. */
const LICENSE_FILE = /^(licen[sc]e|copying|notice)([.-].*)?$/i;
/** A license text is a few pages; anything longer is not one. */
const LARGEST_TEXT = 200_000;
const RULE = "=".repeat(78);

/** The license files of the package installed at `folder`, by name. */
export function licenseTexts(folder) {
  let names;
  try {
    names = readdirSync(folder);
  } catch {
    return [];
  }
  return names
    .filter((name) => LICENSE_FILE.test(name))
    .sort()
    .map((name) => readFileSync(join(folder, name), "utf8").trim())
    .filter((text) => text.length > 0 && text.length <= LARGEST_TEXT);
}

/**
 * The document, from what `pnpm licenses list --long --json` prints:
 * packages by license. A text already printed is named, not repeated.
 */
export function notices(byLicense, read = licenseTexts) {
  const packages = Object.entries(byLicense)
    .flatMap(([license, items]) =>
      items.map((item) => ({
        name: item.name,
        versions: [...(item.versions ?? [])].sort((a, b) =>
          a.localeCompare(b, "en", { numeric: true }),
        ),
        license,
        homepage: item.homepage ?? null,
        author: item.author ?? null,
        folder: item.paths?.[0] ?? null,
      })),
    )
    .sort(
      (left, right) =>
        left.name.localeCompare(right.name, "en") ||
        left.versions.join().localeCompare(right.versions.join(), "en"),
    );
  const printed = new Map();
  const parts = [
    "AnyGridDB is distributed with the libraries listed below. Each one stays",
    "under its own license, reproduced here as its package carries it.",
    "",
    `${String(packages.length)} packages.`,
  ];
  for (const item of packages) {
    const title = `${item.name} ${item.versions.join(", ")}`.trim();
    parts.push("", RULE, title, `License: ${item.license}`);
    if (item.author) parts.push(`Author: ${item.author}`);
    if (item.homepage) parts.push(`Homepage: ${item.homepage}`);
    parts.push(RULE);
    const texts = item.folder ? read(item.folder) : [];
    if (texts.length === 0) {
      parts.push("", "The package carries no license file: see its homepage.");
    }
    for (const text of texts) {
      const first = printed.get(text);
      if (first) {
        parts.push("", `Same text as ${first}, above.`);
        continue;
      }
      printed.set(text, title);
      parts.push("", text);
    }
  }
  return `${parts.join("\n")}\n`;
}

function main() {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const folder = join(root, "apps/web/public");
  const printed = execFileSync(
    "pnpm", // NOSONAR: a check run with the developer's own tools
    ["licenses", "list", "--recursive", "--prod", "--long", "--json"],
    { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  let byLicense;
  try {
    byLicense = JSON.parse(printed);
  } catch {
    console.error("pnpm listed no license: run `pnpm install` first.");
    return 1;
  }
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "third-party-licenses.txt"), notices(byLicense));
  copyFileSync(join(root, "LICENSE"), join(folder, "license.txt"));
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = main();
}
