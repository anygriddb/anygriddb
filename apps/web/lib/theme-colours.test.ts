import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// A class that names a colour the theme does not have draws nothing:
// Tailwind writes no rule for it and says nothing. The theme's colours are
// those of `packages/ui/src/styles.css`; the names below are the ones
// other design systems use for the same things, which a hand writes by
// habit (`text-destructive` stood on three failure screens, in the
// text's own colour, where `text-danger` was meant).

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const FOLDERS = ["apps/web/app", "apps/web/components", "packages/ui/src"];
const THEME = new Set(
  [
    ...readFileSync(join(ROOT, "packages/ui/src/styles.css"), "utf8").matchAll(
      /--color-([a-z-]+):/g,
    ),
  ].map((match) => match[1] ?? ""),
);
const BORROWED = ["destructive", "secondary", "popover", "success", "info"];
const COLOURED =
  /(?:text|bg|border|outline|ring|fill|stroke|divide|decoration)-([a-z]+(?:-[a-z]+)*)/g;

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

/** The colours a source names that the theme does not have. */
function unknownColours(source: string): string[] {
  return [...source.matchAll(COLOURED)]
    .map((match) => match[1] ?? "")
    .filter(
      (name) =>
        !THEME.has(name) &&
        (name.endsWith("-foreground") ||
          BORROWED.some(
            (word) => name === word || name.startsWith(`${word}-`),
          )),
    );
}

describe("unknownColours", () => {
  it("finds a colour named as another design system names it", () => {
    expect(
      unknownColours('"h-6 w-6 text-destructive" "bg-card-foreground"'),
    ).toEqual(["destructive", "card-foreground"]);
  });

  it("lets through the theme's colours, and classes that name none", () => {
    expect(
      unknownColours(
        '"text-danger bg-danger text-danger-foreground text-muted-foreground border-strong-border text-xs text-left bg-transparent outline-ring"',
      ),
    ).toEqual([]);
  });
});

it("no class names a colour the theme does not have", () => {
  const found = FOLDERS.flatMap((folder) =>
    sources(join(ROOT, folder)).flatMap((file) =>
      unknownColours(readFileSync(file, "utf8")).map(
        (name) => `${relative(ROOT, file)}: ${name}`,
      ),
    ),
  );
  expect(found).toEqual([]);
});
