import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
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
const backup = join(root, "scripts", "backup.sh");

/**
 * A `docker` that answers what the script asks of a composition, and runs
 * a container's command here, after its image: the command the script
 * gives the container is the one that runs, with the `tar` beside it.
 */
const FAKE_DOCKER = `#!/bin/sh
case " $* " in
  *" -f - config "*)
    cat >/dev/null
    printf '{"services":{"env":{"environment":{\\n'
    printf '"POSTGRES_USER": "grid",\\n"POSTGRES_DB": "sheets"\\n}}}}\\n'
    exit 0 ;;
  *" config --format json "*) echo '{"services":{}}'; exit 0 ;;
  *" config "*) echo 'name: fake'; exit 0 ;;
  *" volume inspect "*) exit 0 ;;
  *" pg_dump "*) echo dump; exit 0 ;;
  *" run "*)
    while [ "$1" != "postgres:18" ]; do shift; done
    shift
    exec "$@" ;;
esac
exit 0
`;

/** A GNU tar that writes an archive and ends as it is told. */
const FAKE_TAR = `#!/bin/sh
printf 'archive'
exit "\${FAKE_TAR_EXIT:-0}"
`;

async function run(tarExit) {
  const dir = await mkdtemp(join(tmpdir(), "ag-backup-"));
  const bin = join(dir, "bin");
  const kept = join(dir, "backups");
  await mkdir(bin);
  await writeFile(join(bin, "docker"), FAKE_DOCKER);
  await writeFile(join(bin, "tar"), FAKE_TAR);
  await chmod(join(bin, "docker"), 0o755);
  await chmod(join(bin, "tar"), 0o755);
  const envFile = join(dir, ".env");
  await writeFile(envFile, "POSTGRES_USER=grid\nPOSTGRES_DB=sheets\n");
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    ENV_FILE: envFile,
    BACKUP_DIR: kept,
    FAKE_TAR_EXIT: String(tarExit),
  };
  try {
    const { stdout } = await exec("bash", [backup], { env });
    return { code: 0, stdout, folders: await readdir(kept) };
  } catch (error) {
    return {
      code: error.code,
      stdout: error.stdout,
      stderr: error.stderr,
      folders: await readdir(kept).catch(() => []),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("backup.sh", () => {
  it("keeps a backup during which a file changed as tar read it", async () => {
    const done = await run(1);
    assert.equal(done.code, 0, done.stderr);
    assert.match(done.stdout, /Backup: /);
    assert.equal(done.folders.length, 1);
  });

  it("keeps nothing when tar fails otherwise", async () => {
    const failed = await run(2);
    assert.notEqual(failed.code, 0);
    // It failed at the files, once the database was dumped.
    assert.match(failed.stdout, /== Volume fake_files_data/);
    assert.match(failed.stderr, /nothing is kept of it/);
    assert.deepEqual(failed.folders, []);
  });
});
