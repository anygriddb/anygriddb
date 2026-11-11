import { lingui } from "@lingui/vite-plugin";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";
import { defineConfig, type Plugin } from "vite";

// The API serves the built files on its own origin (ADR 0011). In
// development, this server forwards the API's paths to it, so the browser
// sees one origin there too. The API speaks HTTPS only (ADR 0029), with a
// certificate of the instance's own authority: on this machine's loopback,
// the forward does not check it.
const api = process.env.ANYGRIDDB_API ?? "https://localhost:4000";
const forward = { target: api, changeOrigin: false, secure: false };

/** Built files worth a compressed copy: text, a kibibyte or more. */
const COMPRESSIBLE = /\.(?:js|css|svg|json|txt)$/;
const SMALLEST = 1024;

/**
 * Leaves a Brotli and a gzip copy beside each text file of the build. The
 * API sends the copy the browser accepts: compressed once here, as small
 * as it gets, rather than again at every request.
 */
function compressedCopies(): Plugin {
  let folder = "dist";
  return {
    name: "compressed-copies",
    apply: "build",
    configResolved(config) {
      folder = resolve(config.root, config.build.outDir);
    },
    async closeBundle() {
      const names = await readdir(folder, { recursive: true }).catch(
        () => [] as string[],
      );
      await Promise.all(
        names
          .filter((name) => COMPRESSIBLE.test(name))
          .map(async (name) => {
            const file = join(folder, name);
            const bytes = await readFile(file);
            if (bytes.length < SMALLEST) return;
            const [brotli, gzipped] = await Promise.all([
              promisify(brotliCompress)(bytes, {
                params: {
                  [constants.BROTLI_PARAM_QUALITY]:
                    constants.BROTLI_MAX_QUALITY,
                  [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length,
                },
              }),
              promisify(gzip)(bytes, { level: constants.Z_BEST_COMPRESSION }),
            ]);
            await Promise.all([
              writeFile(`${file}.br`, brotli),
              writeFile(`${file}.gz`, gzipped),
            ]);
          }),
      );
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    // Lingui's macros compile messages first, then the React Compiler runs.
    babel({
      plugins: ["@lingui/babel-plugin-lingui-macro"],
      presets: [reactCompilerPreset()],
    }),
    lingui(),
    tailwindcss(),
    compressedCopies(),
  ],
  server: {
    port: 3000,
    strictPort: true,
    proxy: {
      "/api": forward,
      "/trpc": forward,
      "/auth": forward,
      "/health": forward,
      "/ready": forward,
      // Secret addresses PUBLIC_URL hands out: calendar feeds, webhooks.
      "/ical": forward,
      "/hooks": forward,
      "/ws": { ...forward, ws: true },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
    // Hashed file names under /assets: the API caches them for a year.
    assetsDir: "assets",
  },
});
