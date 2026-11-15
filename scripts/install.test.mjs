import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const install = join(root, "scripts", "install.sh");

async function prepared() {
  const dir = await mkdtemp(join(tmpdir(), "ag-install-"));
  await writeFile(
    join(dir, ".env.example"),
    "PUBLIC_URL=https://grid.example.org\n",
  );
  return dir;
}

describe("install.sh", () => {
  it("keeps a password out of .env and encodes it in the database URL", async () => {
    const dir = await prepared();
    try {
      const secrets = join(dir, "secrets");
      await mkdir(secrets, { mode: 0o700 });
      await writeFile(join(secrets, "postgres_password"), "p@ss/w#rd\n", {
        mode: 0o600,
      });
      const { stdout } = await exec("bash", [install, dir]);
      const key = (
        await readFile(join(secrets, "auth_encryption_key"), "utf8")
      ).trim();
      assert.equal(stdout.includes(key), false);
      assert.equal(stdout.includes("p@ss"), false);
      const env = await readFile(join(dir, ".env"), "utf8");
      assert.equal(env.includes("POSTGRES_PASSWORD="), false);
      assert.equal(env.includes("AUTH_ENCRYPTION_KEY="), false);
      assert.equal(env.includes("p@ss"), false);
      assert.match(
        env,
        /^POSTGRES_PASSWORD_FILE=\.\/secrets\/postgres_password$/m,
      );
      const url = await readFile(join(secrets, "database_url"), "utf8");
      assert.match(
        url,
        /^postgres:\/\/anygriddb:p%40ss%2Fw%23rd@db:5432\/anygriddb\?sslmode=verify-full&sslrootcert=\/certs\/internal-authority\.crt\n$/,
      );
      const mode = (await stat(join(secrets, "database_url"))).mode & 0o777;
      assert.equal(mode, 0o600);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("leaves an existing password file alone on a second run", async () => {
    const dir = await prepared();
    try {
      await exec("bash", [install, dir]);
      const first = await readFile(
        join(dir, "secrets", "postgres_password"),
        "utf8",
      );
      await exec("bash", [install, dir]);
      const second = await readFile(
        join(dir, "secrets", "postgres_password"),
        "utf8",
      );
      assert.equal(second, first);
      const env = await readFile(join(dir, ".env"), "utf8");
      assert.equal(env.includes(first.trim()), false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
