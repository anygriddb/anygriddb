// Bundles the API for production: our code and the workspace packages
// (TypeScript sources) go into dist/index.js, dist/import-worker.js, and
// dist/cli.js (the operator commands);
// npm packages stay external and are installed next to them, native ones
// included.
import { cp, readFile, rm } from "node:fs/promises";
import { builtinModules } from "node:module";
import { build } from "esbuild";

const manifest = JSON.parse(await readFile("package.json", "utf8"));
const declared = new Set(Object.keys(manifest.dependencies ?? {}));

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
  // The migrations ship in dist/migrations, next to the bundle.
  define: { __ANYGRID_MIGRATIONS__: JSON.stringify("./migrations") },
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
