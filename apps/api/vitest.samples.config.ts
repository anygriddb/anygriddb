import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/sources/samples/**/*.samples.test.ts"],
    globalSetup: [
      "./src/postgres-global.ts",
      "./src/sources/samples/world-global.ts",
    ],
    fileParallelism: false,
    // Full real-DB matrix: no wall-clock budget.
    hookTimeout: 1_800_000,
    testTimeout: 600_000,
  },
});
