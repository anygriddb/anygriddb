import babel from "@rolldown/plugin-babel";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Modules under test use Lingui's macros: compile them as the app does.
  plugins: [babel({ plugins: ["@lingui/babel-plugin-lingui-macro"] })],
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts", "components/**/*.test.ts"],
  },
});
