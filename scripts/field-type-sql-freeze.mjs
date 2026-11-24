/**
 * Regenerates packages/core/src/query/field-type-sql.freeze.json from the
 * shared freeze catalogs. Run from the product root:
 *   pnpm --filter @anygriddb/api exec tsx ../../scripts/field-type-sql-freeze.mjs
 * or:
 *   pnpm --filter @anygriddb/api exec tsx scripts/field-type-sql-freeze.mjs
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildReadRows } from "../packages/core/src/query/read.ts";
import {
  FIELD_TYPES,
  FREEZE_DIALECTS,
  SIDE_FIELD_TYPES,
  freezeExternalCatalog,
  freezeNativeCatalog,
} from "../packages/core/src/query/field-type-freeze.test-helpers.ts";

const out = {};
const native = freezeNativeCatalog();
for (const type of FIELD_TYPES) {
  const sql = buildReadRows(native, {
    limit: 1,
    fields: [`c_${type}`],
    timeZone: "UTC",
  });
  out[`native:${type}`] = { text: sql.text, values: sql.values };
}
for (const dialect of FREEZE_DIALECTS) {
  const catalog = freezeExternalCatalog(dialect);
  for (const type of SIDE_FIELD_TYPES) {
    const sql = buildReadRows(catalog, {
      limit: 1,
      fields: [`c_${type}`],
      timeZone: "UTC",
    });
    out[`${dialect}:${type}`] = { text: sql.text, values: sql.values };
  }
}

const path = join(
  dirname(fileURLToPath(import.meta.url)),
  "../packages/core/src/query/field-type-sql.freeze.json",
);
writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote ${path} (${Object.keys(out).length} entries)`);
