import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const restore = join(root, "scripts", "restore.sh");

/**
 * A `docker` that answers what the script asks of a composition and writes
 * down every other call: a backup refused here must reach none of them.
 */
const FAKE_DOCKER = `#!/bin/sh
case " $* " in
  *" -f - config "*)
    printf '{"services":{"env":{"environment":{\\n'
    printf '"ANYGRIDDB_ENV_DOLLAR": "$$",\\n"POSTGRES_USER": "grid",\\n"POSTGRES_DB": "sheets",\\n"POSTGRES_PASSWORD": "p"\\n}}}}\\n'
    exit 0 ;;
  *" config --format json "*)
    if [ -n "$FAKE_STORE" ]; then echo '{"volumes":{"rustfs_data":{}}}'; else echo '{"volumes":{}}'; fi
    exit 0 ;;
  *" config "*) echo 'name: fake'; exit 0 ;;
esac
echo "$*" >> "$FAKE_LOG"
exit 0
`;

const sumOf = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** A backup's folder, a fake docker, and the log of what reached it. */
async function prepared({ names, sums }) {
  const dir = await mkdtemp(join(tmpdir(), "ag-restore-"));
  const backup = join(dir, "backup");
  const bin = join(dir, "bin");
  await mkdir(backup);
  await mkdir(bin);
  await writeFile(join(bin, "docker"), FAKE_DOCKER);
  await chmod(join(bin, "docker"), 0o755);
  const log = join(dir, "calls.log");
  await writeFile(log, "");
  const lines = [];
  for (const name of names) {
    const bytes = Buffer.from(`content of ${name}`);
    await writeFile(join(backup, name), bytes);
    lines.push(`${sumOf(bytes)}  ${name}`);
  }
  await writeFile(
    join(backup, "SHA256SUMS"),
    sums === undefined ? `${lines.join("\n")}\n` : sums(lines),
  );
  const envFile = join(dir, ".env");
  await writeFile(envFile, "POSTGRES_USER=grid\nPOSTGRES_DB=sheets\n");
  return { dir, backup, bin, log, envFile };
}

async function refused(setup, options = {}) {
  const { dir, backup, bin, log, envFile } = await prepared(setup);
  try {
    await assert.rejects(
      exec("bash", [restore, backup, "-p", "fake"], {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          ENV_FILE: envFile,
          FAKE_LOG: log,
          ...(options.store ? { FAKE_STORE: "yes" } : {}),
        },
      }),
      (error) => {
        assert.match(error.stderr, options.says);
        return true;
      },
    );
    assert.equal(await readFile(log, "utf8"), "");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const WHOLE = ["database.dump", "files_data.tar.gz", "tls_data.tar.gz"];

describe("restore.sh, before it touches anything", () => {
  it("refuses an empty list of sums", () =>
    refused({ names: WHOLE, sums: () => "" }, { says: /SHA256SUMS/ }));

  it("refuses a list that is not one", () =>
    refused(
      { names: WHOLE, sums: () => "this is not a list of sums\n" },
      { says: /SHA256SUMS/ },
    ));

  it("refuses a list that leaves a file out", () =>
    refused(
      { names: WHOLE, sums: (lines) => `${lines[0]}\n` },
      { says: /files_data\.tar\.gz/ },
    ));

  it("refuses a list that names a file of no backup", () =>
    refused(
      {
        names: WHOLE,
        sums: (lines) =>
          `${lines.join("\n")}\n${"a".repeat(64)}  ../elsewhere\n`,
      },
      { says: /elsewhere/ },
    ));

  it("refuses a file whose sum differs", () =>
    refused(
      {
        names: WHOLE,
        sums: (lines) =>
          `${"0".repeat(64)}  database.dump\n${lines.slice(1).join("\n")}\n`,
      },
      { says: /database\.dump/ },
    ));

  it("refuses a backup missing a file", () =>
    refused(
      { names: ["database.dump", "files_data.tar.gz"] },
      { says: /tls_data\.tar\.gz/ },
    ));

  it("refuses a backup without the store's files on a stack that has one", () =>
    refused({ names: WHOLE }, { store: true, says: /--keep-store-files/ }));
});
