import { config } from "zod/v4";

// Unless told not to, zod compiles its validators, and first tries
// `new Function` to see whether it may. The app is served without
// `unsafe-eval`, so every load of a page broke its own security policy.
// A schema reads this when it is built, and the bundle may run the schemas
// before the app's entry: `vite.config.ts` makes this module the `zod` that
// every other one imports, so that it runs between zod and them.
config({ jitless: true });

export * from "zod/v4";
export { default } from "zod/v4";
