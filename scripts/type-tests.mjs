/**
 * A field type tested by its name in the queries' SQL: `fieldType ===
 * "json"`, or a `switch` on a field's type. What a type does there is said
 * once, in its entry (`packages/core/src/query/field-sql.ts`), which the
 * compiler refuses to leave out for a new type (ADR 0138).
 */
const TESTED =
  /\bfieldType\s*[!=]==?\s*["'`]|["'`]\s*[!=]==?\s*[\w.?]*fieldType\b/g;
const SWITCHED = /\bswitch\s*\(\s*[\w.?]*fieldType\s*\)/g;

/** The numbers (from 1) of the lines of `text` that test a type by name. */
export function typeTestsIn(text) {
  const lines = new Set();
  for (const pattern of [TESTED, SWITCHED]) {
    for (const match of text.matchAll(pattern)) {
      lines.add(text.slice(0, match.index).split("\n").length);
    }
  }
  return [...lines].sort((left, right) => left - right);
}

/** Where a type is not tested by name: the queries, but their registry. */
export const TYPE_TESTS_REFUSED = [
  /^packages\/core\/src\/query\/(?!field-sql\.ts$)[^/]+\.ts$/,
];
