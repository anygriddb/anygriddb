/**
 * Freezes the SQL `buildReadRows` produces for every field type on the
 * native engine and for every side-eligible type on each client dialect.
 * A field-type definition refactor must leave these strings unchanged.
 *
 * Regenerate the map with:
 *   pnpm --filter @anygriddb/api exec tsx scripts/field-type-sql-freeze.mjs
 * then read the diff before committing.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildReadRows } from "./read";
import {
  FIELD_TYPES,
  FREEZE_DIALECTS,
  SIDE_FIELD_TYPES,
  freezeExternalCatalog,
  freezeNativeCatalog,
} from "./field-type-freeze.test-helpers";

type FreezeEntry = { text: string; values: unknown[] };

const frozen = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "field-type-sql.freeze.json"),
    "utf8",
  ),
) as Record<string, FreezeEntry>;

function expectFrozen(key: string, got: FreezeEntry): void {
  const want = frozen[key];
  expect(want, `missing freeze entry ${key}`).toBeDefined();
  expect({ text: got.text, values: got.values }, key).toEqual(want);
}

describe("frozen SQL per field type", () => {
  it("matches the freeze map for every native FieldType", () => {
    const catalog = freezeNativeCatalog();
    for (const type of FIELD_TYPES) {
      const name = `c_${type}`;
      const sql = buildReadRows(catalog, {
        limit: 1,
        fields: [name],
        timeZone: "UTC",
      });
      expectFrozen(`native:${type}`, {
        text: sql.text,
        values: sql.values,
      });
    }
  });

  it("matches the freeze map for every side type on every dialect", () => {
    for (const dialect of FREEZE_DIALECTS) {
      const catalog = freezeExternalCatalog(dialect);
      for (const type of SIDE_FIELD_TYPES) {
        const name = `c_${type}`;
        const sql = buildReadRows(catalog, {
          limit: 1,
          fields: [name],
          timeZone: "UTC",
        });
        expectFrozen(`${dialect}:${type}`, {
          text: sql.text,
          values: sql.values,
        });
      }
    }
  });

  it("covers every FieldType and every side type × dialect once", () => {
    const keys = new Set(Object.keys(frozen));
    for (const type of FIELD_TYPES) {
      expect(keys.has(`native:${type}`), `native:${type}`).toBe(true);
    }
    for (const dialect of FREEZE_DIALECTS) {
      for (const type of SIDE_FIELD_TYPES) {
        expect(keys.has(`${dialect}:${type}`), `${dialect}:${type}`).toBe(true);
      }
    }
    expect(keys.size).toBe(
      FIELD_TYPES.length + FREEZE_DIALECTS.length * SIDE_FIELD_TYPES.length,
    );
  });
});
