import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");

/** The names a Compose file passes to `app`, read from its own lines. */
function appVariables(text) {
  const lines = text.split("\n");
  const app = lines.indexOf("  app:");
  assert.notEqual(app, -1, "no service app");
  const start = lines.indexOf("    environment:", app);
  assert.notEqual(start, -1, "app has no environment");
  const names = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trimStart().startsWith("#")) continue;
    if (!line.startsWith("      ")) break;
    const name = line.trim().split(":")[0];
    if (name) names.push(name);
  }
  return names.sort();
}

/**
 * The arguments a Compose file gives `certs`, read from its flow list, or
 * null when its `certs` gives none.
 */
function certsCommand(text) {
  const lines = text.split("\n");
  const start = lines.indexOf("  certs:");
  if (start === -1) return null;
  const end = lines.findIndex(
    (line, at) => at > start && /^ {2}[a-z_-]+:/.test(line),
  );
  const service = lines.slice(start + 1, end === -1 ? undefined : end);
  const at = service.findIndex((line) => line.startsWith("    command:"));
  if (at === -1) return null;
  const list = service
    .slice(at)
    .join("\n")
    .replace(/^ {4}command:/, "");
  const close = list.indexOf("]");
  return JSON.parse(list.slice(0, close + 1).replace(/,\s*\]$/, "]"));
}

describe("the two ways to run AnyGridDB under Compose", () => {
  it("pass it the same variables", async () => {
    const [bundled, managed] = await Promise.all(
      ["compose.yml", "compose.managed.yml"].map((file) =>
        readFile(join(root, "docker", file), "utf8"),
      ),
    );
    assert.deepEqual(appVariables(managed), appVariables(bundled));
  });

  it("keep the credentials of the tables' owner out of the application", async () => {
    const bundled = await readFile(join(root, "docker", "compose.yml"), "utf8");
    const lines = bundled.split("\n");
    const start = lines.indexOf("  app:");
    const end = lines.findIndex(
      (line, at) => at > start && /^ {2}[a-z_-]+:/.test(line),
    );
    const app = lines.slice(start, end === -1 ? undefined : end).join("\n");
    assert.match(app, /DATABASE_URL: postgres:\/\/anygriddb_app@db:/);
    assert.match(app, /DATABASE_PASSWORD_FILE: \/certs\/app\/db_password/);
    assert.doesNotMatch(app, /POSTGRES_USER|POSTGRES_PASSWORD/);
  });

  it("would see one added to a single file", () => {
    const one =
      "  app:\n    environment:\n      A: a\n      # note\n      B: b\n    volumes:\n";
    const other = "  app:\n    environment:\n      A: a\n    volumes:\n";
    assert.deepEqual(appVariables(one), ["A", "B"]);
    assert.notDeepEqual(appVariables(one), appVariables(other));
  });

  it("keep every argument of certs where an overlay replaces its command", async () => {
    // Compose replaces a list whole: an overlay that gives certs a command
    // repeats the base file's, or loses what it adds. compose.s3.yml lost
    // --application, and 0.7.0 to 0.7.4 never started with it (ADR 0119).
    const base = certsCommand(
      await readFile(join(root, "docker", "compose.yml"), "utf8"),
    );
    assert.ok(base?.includes("--application"), "compose.yml's certs");
    const files = (await readdir(join(root, "docker"))).filter((file) =>
      /^compose\..+\.yml$/.test(file),
    );
    const checked = [];
    for (const file of files) {
      const own = certsCommand(
        await readFile(join(root, "docker", file), "utf8"),
      );
      if (!own) continue;
      assert.deepEqual(own.slice(0, base.length), base, file);
      checked.push(file);
    }
    assert.ok(checked.includes("compose.s3.yml"), "compose.s3.yml is read");
  });

  it("would see an argument an overlay lost", () => {
    const base =
      '  certs:\n    command:\n      [\n        "tls",\n        "--application",\n      ]\n  db:\n    command: ["x"]\n';
    const lost = '  certs:\n    command: ["tls"]\n';
    const none = '  certs:\n    image: x\n  db:\n    command: ["x"]\n';
    assert.deepEqual(certsCommand(base), ["tls", "--application"]);
    assert.notDeepEqual(certsCommand(lost), certsCommand(base));
    assert.equal(certsCommand(none), null);
  });
});
