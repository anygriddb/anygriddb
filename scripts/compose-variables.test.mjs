import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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

describe("the two ways to run AnyGridDB under Compose", () => {
  it("pass it the same variables", async () => {
    const [bundled, managed] = await Promise.all(
      ["compose.yml", "compose.managed.yml"].map((file) =>
        readFile(join(root, "docker", file), "utf8"),
      ),
    );
    assert.deepEqual(appVariables(managed), appVariables(bundled));
  });

  it("would see one added to a single file", () => {
    const one =
      "  app:\n    environment:\n      A: a\n      # note\n      B: b\n    volumes:\n";
    const other = "  app:\n    environment:\n      A: a\n    volumes:\n";
    assert.deepEqual(appVariables(one), ["A", "B"]);
    assert.notDeepEqual(appVariables(one), appVariables(other));
  });
});
