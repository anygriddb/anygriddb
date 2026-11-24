import assert from "node:assert/strict";
import { test } from "node:test";
import { Linter } from "eslint";
import tseslint from "typescript-eslint";
import { SECURITY_RULES } from "../eslint.config.js";

const linter = new Linter({ configType: "flat" });
const config = [
  {
    files: ["**/*.tsx"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: SECURITY_RULES,
  },
];

/** The rules a piece of source breaks, by name. */
function broken(source) {
  return linter
    .verify(source, config, "probe.tsx")
    .map((message) => message.ruleId ?? message.message);
}

test("takes code that runs only what it was written with", () => {
  assert.deepEqual(
    broken(`
      import { execFile, spawn } from "node:child_process";
      execFile("git", ["status"]);
      spawn("pg_dump", ["--format=custom"], { shell: false });
      const view = <p title="x">{"<b>text</b>"}</p>;
      const parse = JSON.parse("{}");
    `),
    [],
  );
});

test("refuses code read from text", () => {
  assert.deepEqual(broken(`eval("1 + 1");`), ["no-eval"]);
  assert.deepEqual(broken(`new Function("return 1");`), ["no-new-func"]);
});

test("refuses HTML set from a value", () => {
  assert.deepEqual(
    broken(`const view = <div dangerouslySetInnerHTML={{ __html: value }} />;`),
    ["no-restricted-syntax"],
  );
});

test("refuses a command line handed to a shell", () => {
  assert.deepEqual(broken(`import { exec } from "node:child_process";`), [
    "no-restricted-imports",
  ]);
  assert.deepEqual(broken(`import { execSync } from "child_process";`), [
    "no-restricted-imports",
  ]);
  assert.deepEqual(broken(`spawn("ls", [dir], { shell: true });`), [
    "no-restricted-syntax",
  ]);
  assert.deepEqual(broken(`execFileSync("ls", [dir], { cwd, shell: true });`), [
    "no-restricted-syntax",
  ]);
});
