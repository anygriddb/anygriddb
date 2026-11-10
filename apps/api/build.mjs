// Bundles the API for production: our code and the workspace packages
// (TypeScript sources) go into dist/index.js, dist/import-worker.js, and
// dist/cli.js (the operator commands);
// npm packages stay external and are installed next to them, native ones
// included.
import { execFileSync } from "node:child_process";
import { cp, readFile, rm } from "node:fs/promises";
import { builtinModules } from "node:module";
import { build } from "esbuild";

const manifest = JSON.parse(await readFile("package.json", "utf8"));
const declared = new Set(Object.keys(manifest.dependencies ?? {}));

// Which AnyGridDB the bundle is (ADR 0048): the root package.json's
// version, the commit (ANYGRIDDB_COMMIT, else the checkout's when git
// answers), and when it was built. A release build names its version in
// ANYGRIDDB_VERSION: it must be package.json's.
const { version } = JSON.parse(await readFile("../../package.json", "utf8"));
if (typeof version !== "string") {
  console.error("The root package.json has no version.");
  process.exit(1);
}
const wanted = process.env.ANYGRIDDB_VERSION?.replace(/^v/, "");
if (wanted && wanted !== version) {
  console.error(
    `ANYGRIDDB_VERSION is ${wanted}, but package.json says ${version}.`,
  );
  process.exit(1);
}
function checkoutCommit() {
  try {
    return (
      execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || null
    );
  } catch {
    return null;
  }
}
const commit =
  process.env.ANYGRIDDB_COMMIT?.trim().toLowerCase() || checkoutCommit();
if (commit !== null && !/^[0-9a-f]{7,64}$/.test(commit)) {
  console.error(`ANYGRIDDB_COMMIT is not a commit hash: ${commit}`);
  process.exit(1);
}
const buildInfo = { version, commit, builtAt: new Date().toISOString() };

await rm("dist", { recursive: true, force: true });

const result = await build({
  // The import parser runs in a worker thread of its own (ADR 0025).
  entryPoints: {
    index: "src/index.ts",
    "import-worker": "src/import-worker.ts",
    cli: "src/cli.ts",
  },
  outdir: "dist",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node26",
  sourcemap: true,
  metafile: true,
  logLevel: "info",
  define: {
    // The migrations ship in dist/migrations, next to the bundle.
    __ANYGRID_MIGRATIONS__: JSON.stringify("./migrations"),
    __ANYGRID_BUILD__: JSON.stringify(buildInfo),
  },
  plugins: [
    {
      name: "external-packages",
      setup(context) {
        // A bare specifier is an npm package, except our own workspace.
        context.onResolve({ filter: /^[^./]/ }, (args) =>
          args.path.startsWith("@anygriddb/")
            ? undefined
            : { path: args.path, external: true },
        );
      },
    },
  ],
});

// Every package the bundle imports must be a dependency of this package,
// or the production install would leave it out.
const builtins = new Set(builtinModules);
const missing = new Set();
for (const output of Object.values(result.metafile.outputs)) {
  for (const entry of output.imports) {
    if (!entry.external) continue;
    const specifier = entry.path.replace(/^node:/, "");
    if (
      builtins.has(specifier.split("/")[0]) ||
      entry.path.startsWith("node:")
    ) {
      continue;
    }
    const parts = entry.path.split("/");
    const name = entry.path.startsWith("@")
      ? parts.slice(0, 2).join("/")
      : parts[0];
    if (!declared.has(name)) missing.add(name);
  }
}
if (missing.size > 0) {
  console.error(`Undeclared runtime packages: ${[...missing].join(", ")}`);
  process.exit(1);
}

await cp("../../packages/db/migrations", "dist/migrations", {
  recursive: true,
});
