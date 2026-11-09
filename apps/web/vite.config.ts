import { lingui } from "@lingui/vite-plugin";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The API serves the built files on its own origin (ADR 0011). In
// development, this server forwards the API's paths to it, so the browser
// sees one origin there too. The API speaks HTTPS only (ADR 0029), with a
// certificate of the instance's own authority: on this machine's loopback,
// the forward does not check it.
const api = process.env.ANYGRIDDB_API ?? "https://localhost:4000";
const forward = { target: api, changeOrigin: false, secure: false };

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
  ],
  server: {
    port: 3000,
    strictPort: true,
    proxy: {
      "/api": forward,
      "/trpc": forward,
      "/auth": forward,
      "/health": forward,
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
