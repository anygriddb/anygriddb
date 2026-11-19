import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// An instant is written the same way on every screen: in the tag
// `intlLocale` gives for the app's language (`lib/format.ts`). A call
// that names no tag, or hands Intl the app's language as it is, follows
// the browser or `en-US`: month first, a clock of 12 hours. Nothing but
// reading the sources tells them apart.

const WEB = fileURLToPath(new URL("..", import.meta.url));
const FOLDERS = ["app", "components", "lib"];
/** Where the tag is decided, and a cell's own format (ISO, US) chosen. */
const SPARED = new Set(["lib/format.ts"]);

function sources(folder: string, found: string[] = []): string[] {
  for (const name of readdirSync(folder)) {
    const path = join(folder, name);
    if (statSync(path).isDirectory()) sources(path, found);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      found.push(path);
    }
  }
  return found;
}

/** The calls of a source that leave a date's format to someone else. */
function leftToTheBrowser(source: string): string[] {
  const calls =
    source.match(
      /(?:toLocale(?:Date|Time)?String|new Intl\.DateTimeFormat)\(\s*[^\s,)]*/g,
    ) ?? [];
  return calls.filter(
    (call) => !/\(\s*(?:intlLocale\(|intl$|"sv-SE"$)/.test(call),
  );
}

describe("leftToTheBrowser", () => {
  it("finds a date written as the browser pleases, or in the app's bare language", () => {
    expect(
      leftToTheBrowser(
        [
          "new Date(value).toLocaleString()",
          "new Date(value).toLocaleTimeString([], { hour: '2-digit' })",
          "new Date(value).toLocaleDateString(i18n.locale)",
          "new Intl.DateTimeFormat(locale, { dateStyle: 'medium' })",
        ].join("\n"),
      ),
    ).toHaveLength(4);
  });

  it("lets through the app's tag, and a day written for a file's name", () => {
    expect(
      leftToTheBrowser(
        [
          "new Date(value).toLocaleString(intlLocale(locale), { dateStyle: 'long' })",
          "new Intl.DateTimeFormat(\n  intlLocale(i18n.locale),\n  options,\n)",
          "new Intl.DateTimeFormat(intl, { month: 'long' })",
          'new Date().toLocaleDateString("sv-SE")',
          "Intl.DateTimeFormat().resolvedOptions().timeZone",
        ].join("\n"),
      ),
    ).toEqual([]);
  });
});

it("no screen leaves a date's format to the browser", () => {
  const found = FOLDERS.flatMap((folder) =>
    sources(join(WEB, folder))
      .filter((file) => !SPARED.has(relative(WEB, file)))
      .flatMap((file) =>
        leftToTheBrowser(readFileSync(file, "utf8")).map(
          (call) => `${relative(WEB, file)}: ${call}`,
        ),
      ),
  );
  expect(found).toEqual([]);
});
