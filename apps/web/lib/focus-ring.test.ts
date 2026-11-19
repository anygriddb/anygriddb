import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// A control shows where the keyboard is with an outline, written
// `focus-visible:outline-2 focus-visible:outline-ring` (or under React
// Aria's `data-[focus-visible]:`). Tailwind's `outline-none` turns the
// outline's style off for every state of the element: beside it, that
// outline is two pixels wide and drawn by nothing. The build says nothing
// and no accessibility check looks at it, so the sources are read here.

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const FOLDERS = ["apps/web/app", "apps/web/components", "packages/ui/src"];

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

/** The class lists of a source that hide the outline they ask for. */
function hiddenRings(source: string): string[] {
  const lists = source.match(/"[^"\n]*"|'[^'\n]*'|`[^`]*`/g) ?? [];
  return lists.filter((list) => {
    const classes = list.slice(1, -1).split(/\s+/);
    return (
      classes.includes("outline-none") &&
      classes.some((name) => /(^|:)outline-\d+$/.test(name))
    );
  });
}

describe("hiddenRings", () => {
  it("finds an outline that its own class list turns off", () => {
    expect(
      hiddenRings(
        'cn("rounded outline-none data-[focus-visible]:outline-2 data-[focus-visible]:outline-ring")',
      ),
    ).toHaveLength(1);
  });

  it("lets through a ring left on, one drawn as a shadow, and none at all", () => {
    expect(
      hiddenRings(
        [
          '"rounded focus-visible:outline-2 focus-visible:outline-ring"',
          '"outline-none focus-visible:ring-2 focus-visible:ring-ring"',
          '"z-50 bg-card outline-none"',
        ].join("\n"),
      ),
    ).toEqual([]);
  });
});

it("no control hides the focus ring it draws", () => {
  const found = FOLDERS.flatMap((folder) =>
    sources(join(ROOT, folder)).flatMap((file) =>
      hiddenRings(readFileSync(file, "utf8")).map(
        (list) => `${relative(ROOT, file)}: ${list.slice(0, 80)}`,
      ),
    ),
  );
  expect(found).toEqual([]);
});
