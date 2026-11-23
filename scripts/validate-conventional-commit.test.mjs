// The message check of the hook and of CI: one rule set for both, the
// lines under the header included.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(
  new URL("./validate-conventional-commit.sh", import.meta.url),
);

function check(message) {
  const folder = mkdtempSync(join(tmpdir(), "commit-msg-"));
  try {
    const file = join(folder, "message");
    writeFileSync(file, message);
    const run = spawnSync("sh", [script, file], { encoding: "utf8" });
    return { status: run.status, said: run.stderr };
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

test("takes a header of its type, and a description however short", () => {
  assert.equal(check("fix(api): refuse an unknown source\n").status, 0);
  assert.equal(check("feat!: drop a setting\n\nIt did nothing.\n").status, 0);
  assert.equal(check("fix: a\n").status, 0);
});

test("refuses a header that is no such one, or too long", () => {
  for (const header of [
    "update things",
    "fix:",
    "fix: ends with a period.",
    `fix: ${"x".repeat(96)}`,
  ]) {
    assert.equal(check(`${header}\n`).status, 1, header);
  }
});

test("holds the lines under the header to a hundred characters", () => {
  const long = "x".repeat(101);
  const refused = check(`fix: say it\n\n${long}\n`);
  assert.equal(refused.status, 1);
  assert.match(refused.said, /at most 100 characters/);
  assert.equal(check(`fix: say it\n\n${"x".repeat(100)}\n`).status, 0);
  // An address is not cut to fit.
  assert.equal(
    check(`fix: say it\n\nSee https://example.org/${long}\n`).status,
    0,
  );
  // What git leaves as a comment is no line of the message.
  assert.equal(check(`fix: say it\n\n# ${long}\n`).status, 0);
});
