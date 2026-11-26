import assert from "node:assert/strict";
import { test } from "node:test";
import { TYPE_TESTS_REFUSED, typeTestsIn } from "./type-tests.mjs";

test("finds a field type tested by its name, or a switch on it", () => {
  const text = [
    'if (column.fieldType === "json") return ref;',
    'const fixed = "boolean" !== draft.fieldType;',
    "switch (column.fieldType) {",
    '  case "text":',
    "}",
  ].join("\n");
  assert.deepEqual(typeTestsIn(text), [1, 2, 3]);
});

test("leaves alone what reads a type's entry, and other switches", () => {
  const text = [
    'if (holdsOf(column.fieldType) === "document") return ref;',
    "switch (FIELD_SQL[column.fieldType].read) {",
    "switch (typed.kind) {",
    "const same = left.fieldType === right.fieldType;",
  ].join("\n");
  assert.deepEqual(typeTestsIn(text), []);
});

test("refuses it in the queries, not in their registry nor elsewhere", () => {
  const refused = (path) =>
    TYPE_TESTS_REFUSED.some((pattern) => pattern.test(path));
  assert.equal(refused("packages/core/src/query/read.ts"), true);
  assert.equal(refused("packages/core/src/query/field-sql.ts"), false);
  assert.equal(refused("packages/core/src/airtable.ts"), false);
});
