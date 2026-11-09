import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { contrastRatio } from "./contrast";

const css = readFileSync(
  fileURLToPath(new URL("./styles.css", import.meta.url)),
  "utf8",
);

/** The `--ag-*` hex tokens of one theme block of `styles.css`. */
function tokens(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  const end = css.indexOf("}", start);
  if (start < 0 || end < 0) throw new Error(`No block for ${selector}`);
  const out: Record<string, string> = {};
  for (const [, name, hex] of css
    .slice(start, end)
    .matchAll(/--ag-([a-z0-9-]+):\s*(#[0-9a-f]{6})/g)) {
    if (name && hex) out[name] = hex;
  }
  return out;
}

/** Text on the surfaces it is written on: WCAG AA, 4.5:1. */
const TEXT_PAIRS: ReadonlyArray<[string, string]> = [
  ["foreground", "background"],
  ["foreground", "card"],
  ["foreground", "muted"],
  ["foreground", "accent"],
  ["foreground", "highlight"],
  ["muted-foreground", "background"],
  ["muted-foreground", "card"],
  ["muted-foreground", "muted"],
  ["primary", "card"],
  ["primary", "background"],
  ["primary-foreground", "primary"],
  ["accent-foreground", "accent"],
  ["danger", "card"],
  ["danger", "background"],
  ["danger-foreground", "danger"],
];

/** Non-text marks that carry meaning: focus ring and margin rule, 3:1. */
const MARK_PAIRS: ReadonlyArray<[string, string]> = [
  ["ring", "card"],
  ["ring", "background"],
  ["margin", "card"],
];

describe.each([
  ["light", ":root"],
  ["dark", '[data-theme="dark"]'],
])("%s theme tokens", (_, selector) => {
  const palette = tokens(selector);

  it.each(TEXT_PAIRS)("%s reads at 4.5:1 on %s", (text, surface) => {
    expect(palette[text]).toBeDefined();
    expect(palette[surface]).toBeDefined();
    expect(
      contrastRatio(palette[text] ?? "", palette[surface] ?? ""),
    ).toBeGreaterThanOrEqual(4.5);
  });

  it.each(MARK_PAIRS)("%s shows at 3:1 on %s", (mark, surface) => {
    expect(
      contrastRatio(palette[mark] ?? "", palette[surface] ?? ""),
    ).toBeGreaterThanOrEqual(3);
  });
});

describe("contrastRatio", () => {
  it("spans 1 to 21", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 5);
    expect(contrastRatio("#808080", "#808080")).toBe(1);
  });

  it("fails a pair the eye fails", () => {
    // Light grey on white: a common mistake for muted text.
    expect(contrastRatio("#9ca3af", "#ffffff")).toBeLessThan(4.5);
  });

  it("rejects colours that are not #rrggbb", () => {
    expect(() => contrastRatio("#fff", "#ffffff")).toThrow();
    expect(() => contrastRatio("white", "#ffffff")).toThrow();
  });
});
