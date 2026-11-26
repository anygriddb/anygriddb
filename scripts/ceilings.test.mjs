import assert from "node:assert/strict";
import { test } from "node:test";
import { ceilingsIn } from "./ceilings.mjs";

test("finds a ceiling a module declares as a number, or an object of numbers", () => {
  const text = [
    "const MAX_ROWS = 1_000;",
    "export const LINK_TTL_MS = 24 * 60 * 60 * 1000;",
    "export const SCRIPT_LIMITS = {",
    "  /** A comment. */",
    "  timeMs: 10_000,",
    "  memoryBytes: 64 * 1024 * 1024,",
    "} as const;",
  ].join("\n");
  assert.deepEqual(
    ceilingsIn(text).map(({ name, line }) => [name, line]),
    [
      ["MAX_ROWS", 1],
      ["LINK_TTL_MS", 2],
      ["SCRIPT_LIMITS", 3],
    ],
  );
});

test("leaves alone what reads the catalogue, what is no ceiling, and what holds no number", () => {
  const text = [
    'const MAX_ROWS = ceilingOf("read.rows_per_page");',
    "const PAGE = 500;",
    "const DAY_MS = 86_400_000;",
    'const MAX_LABEL = "most";',
    "const MAX_OF = (a, b) => Math.max(a, b);",
  ].join("\n");
  assert.deepEqual(ceilingsIn(text), []);
});
