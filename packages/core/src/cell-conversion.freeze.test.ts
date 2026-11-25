/**
 * Freezes what a stored value becomes when its field changes type
 * (`convertCell`), and what a value the trail holds becomes in a field as
 * it is now (`restoredCell`), for a fixed set of values, from several
 * types into every writable one. A refactor of the conversions must leave
 * the map unchanged; a change of behaviour shows in its diff.
 *
 * Regenerate after a change made on purpose, then read the diff:
 *   FREEZE_WRITE=1 pnpm --filter @anygriddb/core exec vitest run src/cell-conversion.freeze.test.ts
 *   pnpm exec prettier --write packages/core/src/cell-conversion.freeze.json
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { convertCell, restoredCell, type StoredCell } from "./cell-conversion";
import type { CellColumn } from "./cell-values";
import {
  WRITABLE_TYPES,
  type FieldType,
  type WritableType,
} from "./field-types";

const OPTIONS = [
  { name: "Open", color: "green" as const },
  { name: "Closed", color: "gray" as const },
];

const PERSON = "11111111-1111-4111-8111-111111111111";

/** Each writable type as a field, with what its rules need. */
function columnOf(type: WritableType): CellColumn {
  switch (type) {
    case "single_select":
    case "multi_select":
      return { fieldType: type, config: { options: OPTIONS } };
    case "rating":
      return { fieldType: type, config: { ratingMax: 5 } };
    default:
      return { fieldType: type, config: {} };
  }
}

/** Values as the database gives them back, of every shape it has. */
const STORED: readonly StoredCell[] = [
  "",
  "  ",
  "Hello",
  "Open",
  "open",
  "42",
  "7.25",
  "-3",
  "1,5",
  "0",
  "1:30",
  "2026-02-28",
  "28/02/2026",
  "2026-01-10T09:30:00Z",
  "2026-01-10 09:30",
  "yes",
  "non",
  "a@example.org",
  "https://example.org/x",
  "+33 1 23 45 67 89",
  "#1f3fae",
  "48.8566, 2.3522",
  '{"a":1}',
  "[1,2]",
  "★★★",
  "Open, Closed",
  true,
  false,
  [],
  ["Open"],
  ["Open", "Closed"],
  ["Nope"],
  [PERSON],
];

/** The types a value comes from, which some rules read. */
const FROM: readonly FieldType[] = [
  "text",
  "number",
  "boolean",
  "multi_select",
  "date",
];

/** A value as the map writes it: `undefined` is no fit, kept apart from null. */
function written(value: unknown): unknown {
  return value === undefined ? "<no fit>" : value;
}

const FREEZE = join(
  dirname(fileURLToPath(import.meta.url)),
  "cell-conversion.freeze.json",
);
const frozen = (
  existsSync(FREEZE) ? JSON.parse(readFileSync(FREEZE, "utf8")) : {}
) as { convert?: unknown; restore?: unknown };
const made: { convert?: unknown; restore?: unknown } = {};

/** Holds a map to the frozen one, or writes it when asked. */
function frozenAs(part: "convert" | "restore", map: unknown): void {
  made[part] = map;
  if (process.env["FREEZE_WRITE"]) {
    writeFileSync(
      FREEZE,
      `${JSON.stringify({ ...frozen, ...made }, null, 2)}\n`,
    );
    return;
  }
  expect(map).toEqual(frozen[part]);
}

describe("frozen conversions per field type", () => {
  it("convert every stored value from several types into every writable one", () => {
    const map: Record<string, unknown> = {};
    for (const to of WRITABLE_TYPES) {
      const column = columnOf(to);
      for (const from of FROM) {
        for (const stored of STORED) {
          const key = `${from}>${to}:${JSON.stringify(stored)}`;
          map[key] = written(convertCell(from, column, stored, "UTC"));
          if (to === "datetime") {
            map[`${key}:no zone`] = written(
              convertCell(from, column, stored, undefined),
            );
          }
        }
      }
    }
    frozenAs("convert", map);
  });

  it("restore every value the trail holds into every writable type", () => {
    const map: Record<string, unknown> = {};
    for (const to of WRITABLE_TYPES) {
      for (const held of STORED) {
        map[`${to}:${JSON.stringify(held)}`] = written(
          restoredCell(columnOf(to), held),
        );
      }
    }
    frozenAs("restore", map);
  });
});
