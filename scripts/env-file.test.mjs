import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const reader = join(root, "scripts", "env-file.sh");

function hasCompose() {
  try {
    execFileSync("docker", ["compose", "version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const skip = hasCompose() ? false : "needs the docker compose command";

/** Each name's value after the reader ran on a .env holding `text`. */
async function read(text, names, env = {}) {
  const dir = await mkdtemp(join(tmpdir(), "ag-env-"));
  try {
    const file = join(dir, ".env");
    await writeFile(file, text);
    const show = names
      .map((name) => `printf '%s\\0' "\${${name}-}"`)
      .join("; ");
    const { stdout } = await exec(
      "bash",
      [
        "-c",
        `set -euo pipefail; . "$1"; read_env_file "$2" ${names.join(" ")}; ${show}`,
        "bash",
        reader,
        file,
      ],
      { env: { ...process.env, ...env } },
    );
    return stdout.split("\0").slice(0, -1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("env-file.sh", { skip }, () => {
  it("gives each value as Compose reads it", async () => {
    const lines = [
      [
        "SPACES",
        "a.example.test b.example.test",
        "a.example.test b.example.test",
      ],
      [
        "ANGLES",
        "AnyGridDB <grid@example.test>",
        "AnyGridDB <grid@example.test>",
      ],
      ["AMP", "a@example.test&b", "a@example.test&b"],
      ["PARENS", "grid(prod)", "grid(prod)"],
      ["DOUBLE", '"two words"', "two words"],
      ["SINGLE", "'single $NOPE'", "single $NOPE"],
      ["HASH", "p@ss/w#rd", "p@ss/w#rd"],
      ["COMMENT", "value # said after it", "value"],
      ["ACCENTS", "é€ü", "é€ü"],
      ["DOLLARS", "pa$$word", "pa$word"],
      ["BREAK", '"one\\ntwo"', "one\ntwo"],
    ];
    const text = `${lines.map(([name, raw]) => `${name}=${raw}`).join("\n")}\nexport EXPORTED=kept\n`;
    const names = [...lines.map(([name]) => name), "EXPORTED", "ABSENT"];
    const values = await read(text, names);
    assert.deepEqual(values, [
      ...lines.map(([, , value]) => value),
      "kept",
      "",
    ]);
  });

  it("never runs what a value holds", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ag-env-mark-"));
    const first = join(dir, "first");
    const second = join(dir, "second");
    try {
      const [dollar, ticks] = await read(
        `DOLLAR=$(touch ${first})grid\nTICKS=\`touch ${second}\`\n`,
        ["DOLLAR", "TICKS"],
      );
      assert.equal(dollar, `$(touch ${first})grid`);
      assert.equal(ticks, `\`touch ${second}\``);
      await assert.rejects(access(first));
      await assert.rejects(access(second));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("lets a variable already set win, as Compose does", async () => {
    const [value] = await read("POSTGRES_DB=from-file\n", ["POSTGRES_DB"], {
      POSTGRES_DB: "from-shell",
    });
    assert.equal(value, "from-shell");
  });

  it("refuses a file Compose cannot read, and prints none of it", async () => {
    await assert.rejects(
      read(
        'FIRST=hidden-value-1\nBROKEN="never closed\nLAST=hidden-value-2\n',
        ["FIRST"],
      ),
      (error) => {
        assert.match(error.stderr, /could not be read/);
        assert.doesNotMatch(error.stderr, /hidden-value/);
        return true;
      },
    );
  });
});
