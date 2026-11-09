import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    exclude: [
      "**/*.integration.test.ts",
      "**/*.samples.test.ts",
      "**/node_modules/**",
      "**/dist/**",
    ],
  },
});
