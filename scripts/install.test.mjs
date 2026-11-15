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
const loader = join(root, "scripts", "secret-files.sh");

/** An install's folder: its Compose file and the given .env. */
async function prepared(env) {
  const dir = await mkdtemp(join(tmpdir(), "ag-install-"));
  await writeFile(join(dir, "compose.yml"), "services: {}\n");
  await writeFile(
    join(dir, ".env.example"),
    "POSTGRES_USER=anygriddb\nPOSTGRES_PASSWORD=\nPOSTGRES_DB=anygriddb\nAUTH_ENCRYPTION_KEY=\n",
  );
  if (env !== undefined) await writeFile(join(dir, ".env"), env);
  return dir;
}

const modeOf = async (path) => (await stat(path)).mode & 0o777;

describe("install.sh", () => {
  it("makes both secrets on a first install, and .env holds neither", async () => {
    const dir = await prepared();
    try {
      const { stdout } = await exec("bash", [install, dir]);
      const secrets = join(dir, "secrets");
      const password = (
        await readFile(join(secrets, "postgres_password"), "utf8")
      ).trim();
      const key = (
        await readFile(join(secrets, "auth_encryption_key"), "utf8")
      ).trim();
      assert.match(password, /^[0-9a-f]{64}$/);
      assert.equal(Buffer.from(key, "base64").length, 32);
      assert.equal(stdout.includes(password), false);
      assert.equal(stdout.includes(key), false);
      const env = await readFile(join(dir, ".env"), "utf8");
      assert.doesNotMatch(env, /^POSTGRES_PASSWORD=/m);
      assert.doesNotMatch(env, /^AUTH_ENCRYPTION_KEY=/m);
      assert.match(
        env,
        /^AUTH_ENCRYPTION_KEY_FILE=\.\/secrets\/auth_encryption_key$/m,
      );
      assert.equal(await modeOf(secrets), 0o700);
      assert.equal(await modeOf(join(secrets, "postgres_password")), 0o644);
      assert.equal(await modeOf(join(dir, ".env")), 0o600);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("moves the values of an install that runs, and leaves its other settings", async () => {
    const dir = await prepared(
      "POSTGRES_USER=grid\nPOSTGRES_PASSWORD=p@ss/w#rd\nPOSTGRES_DB=sheets\nAUTH_ENCRYPTION_KEY=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=\nS3_SECRET_KEY=kept-here\n",
    );
    try {
      await exec("bash", [install, dir]);
      const secrets = join(dir, "secrets");
      assert.equal(
        await readFile(join(secrets, "postgres_password"), "utf8"),
        "p@ss/w#rd\n",
      );
      assert.equal(
        await readFile(join(secrets, "auth_encryption_key"), "utf8"),
        "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=\n",
      );
      const env = await readFile(join(dir, ".env"), "utf8");
      assert.equal(env.includes("p@ss"), false);
      assert.match(env, /^S3_SECRET_KEY=kept-here$/m);
      assert.match(env, /^POSTGRES_USER=grid$/m);
      assert.equal(
        await readFile(join(secrets, "database_url"), "utf8"),
        "postgres://grid:p%40ss%2Fw%23rd@db:5432/sheets?sslmode=verify-full&sslrootcert=/certs/internal-authority.crt\n",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("changes nothing when run again", async () => {
    const dir = await prepared();
    try {
      await exec("bash", [install, dir]);
      const read = () =>
        Promise.all([
          readFile(join(dir, "secrets", "postgres_password"), "utf8"),
          readFile(join(dir, "secrets", "auth_encryption_key"), "utf8"),
          readFile(join(dir, ".env"), "utf8"),
        ]);
      const first = await read();
      await exec("bash", [install, dir]);
      assert.deepEqual(await read(), first);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses a .env whose key differs from its file, and a database of one's own", async () => {
    const dir = await prepared("AUTH_ENCRYPTION_KEY=another\n");
    try {
      await mkdir(join(dir, "secrets"), { mode: 0o700 });
      await writeFile(join(dir, "secrets", "auth_encryption_key"), "first\n");
      await assert.rejects(exec("bash", [install, dir]), /differs/);
      assert.equal(
        await readFile(join(dir, ".env"), "utf8"),
        "AUTH_ENCRYPTION_KEY=another\n",
      );
      await writeFile(
        join(dir, ".env"),
        "DATABASE_URL=postgres://u:p@db.example.org/x\n",
      );
      await assert.rejects(exec("bash", [install, dir]), /DATABASE_URL/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("secret-files.sh", () => {
  const read = (dir, preset = "") =>
    exec("bash", [
      "-c",
      `${preset} . "$1"; load_secret_files "$2"; printf '%s|%s' "$POSTGRES_PASSWORD" "$AUTH_ENCRYPTION_KEY"`,
      "bash",
      loader,
      dir,
    ]);

  it("reads each secret from its file, the one .env names first", async () => {
    const dir = await prepared();
    try {
      await mkdir(join(dir, "secrets"));
      await writeFile(
        join(dir, "secrets", "postgres_password"),
        "from-file\r\n",
      );
      await writeFile(join(dir, "named-key"), "named\n");
      const { stdout } = await read(
        dir,
        "export AUTH_ENCRYPTION_KEY_FILE=named-key;",
      );
      assert.equal(stdout, "from-file|named");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("leaves a variable already set, and one with no file", async () => {
    const dir = await prepared();
    try {
      await mkdir(join(dir, "secrets"));
      await writeFile(join(dir, "secrets", "postgres_password"), "from-file\n");
      const { stdout } = await read(dir, "export POSTGRES_PASSWORD=set;");
      assert.equal(stdout, "set|");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
