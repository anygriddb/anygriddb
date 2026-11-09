import { defineConfig } from "@lingui/conf";
import { formatter } from "@lingui/format-po";

// English is the source language (ADR 0041); translators work on PO files,
// which Weblate reads and writes (see docs/weblate.md).
export default defineConfig({
  sourceLocale: "en",
  locales: ["en", "fr"],
  catalogs: [
    {
      path: "<rootDir>/locales/{locale}/messages",
      include: ["<rootDir>/app", "<rootDir>/components", "<rootDir>/lib"],
      exclude: ["**/*.test.ts"],
    },
  ],
  format: formatter({ lineNumbers: false }),
});
