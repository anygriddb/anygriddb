import { defineConfig } from "@playwright/test";

// The API serves the built app on its own origin, as in production
// (ADR 0011): the journey runs against that one server.
// HTTPS only (ADR 0029): the test server makes its own authority, which
// this browser does not know.
const appUrl = process.env.PUBLIC_URL ?? "https://localhost:4010";
const port = new URL(appUrl).port || "4010";
// Set by `pnpm test:e2e:coverage`: the server writes what it ran when it ends.
const coverageDir = process.env.E2E_COVERAGE_DIR;
const serve = coverageDir
  ? `NODE_V8_COVERAGE=${JSON.stringify(`${coverageDir}/server-raw`)} pnpm exec tsx src/index.ts`
  : "pnpm exec tsx src/index.ts";

export default defineConfig({
  testDir: "e2e",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: appUrl,
    browserName: "chromium",
    // A toast fading in has, for a moment, too little contrast: an
    // accessibility check that lands then fails. With reduced motion, as
    // a person who asks for it sees them, toasts and panels appear whole.
    reducedMotion: "reduce",
    ignoreHTTPSErrors: true,
    // Accepted by the certificate verifier itself: with the option above
    // alone, Chromium refuses the handshake of each new connection first
    // (alert 46) and retries it, and a page's last asset could fail with
    // ERR_TOO_MANY_RETRIES. A browser where someone accepted the
    // certificate does not do this.
    launchOptions: { args: ["--ignore-certificate-errors"] },
  },
  projects: [
    // The instance's first account, made with its operator's token
    // (ADR 0080): once, before anything else signs up.
    {
      name: "first-account",
      testMatch: /first-account\.setup\.ts/,
    },
    {
      name: "journeys",
      testIgnore: /(maintenance|security)\.spec\.ts/,
      dependencies: ["first-account"],
    },
    // The security policy changes instance settings (ADR 0043): alone,
    // after the journeys.
    {
      name: "security",
      testMatch: /security\.spec\.ts/,
      dependencies: ["journeys"],
    },
    // Maintenance signs everyone else out: after every other journey.
    {
      name: "maintenance",
      testMatch: /maintenance\.spec\.ts/,
      dependencies: ["security"],
    },
  ],
  webServer: [
    {
      command: `pnpm --filter @anygriddb/web build && ${serve}`,
      ...(coverageDir
        ? { gracefulShutdown: { signal: "SIGTERM" as const, timeout: 20_000 } }
        : {}),
      cwd: "../api",
      url: `${appUrl}/health`,
      ignoreHTTPSErrors: true,
      reuseExistingServer: !process.env.CI && !coverageDir,
      timeout: 180_000,
      env: {
        ...process.env,
        AUTH_ENCRYPTION_KEY: process.env.AUTH_ENCRYPTION_KEY ?? "",
        // A folder of their own: the development server's certificates are
        // sealed under another key, and the start refuses what it cannot open.
        TLS_DIR: process.env.TLS_DIR ?? "./data/tls-journeys",
        PUBLIC_URL: appUrl,
        PORT: port,
        // The sources journey reads a database on the same server, which
        // has no certificate: for this test server only.
        ANYGRIDDB_SOURCES_ALLOWED_HOSTS: "127.0.0.1,localhost",
        // The mail catcher of scripts/e2e.sh: sign-ups and reset links are
        // mailed, and the journeys read them (MAIL_API in e2e/setup.ts).
        SMTP_HOST: process.env.SMTP_HOST ?? "127.0.0.1",
        SMTP_PORT: process.env.SMTP_PORT ?? "1026",
        SMTP_FROM: process.env.SMTP_FROM ?? "grid@example.org",
        ANYGRIDDB_SOURCES_ALLOW_PLAINTEXT: "true",
        // The browser is the TCP peer. Trusting loopback lets a journey
        // choose X-Forwarded-For. Production leaves this empty.
        ANYGRIDDB_TRUSTED_PROXIES:
          process.env.ANYGRIDDB_TRUSTED_PROXIES ?? "127.0.0.1,::1",
      },
    },
  ],
});
