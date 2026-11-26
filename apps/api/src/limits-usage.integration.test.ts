/**
 * Administration's "Limits and usage" (ADR 0132): every limit as the
 * instance keeps it, what is used of the requests a minute and of the
 * jobs, the rates an administrator sets within their bounds, and nobody
 * else.
 */
import { randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keyRing } from "./auth/key-ring.js";
import type { Env } from "./env.js";
import { exportCeiling, importCeiling } from "./row-ceilings.js";
import { readGateSettings } from "./settings.js";
import { createTestDatabase } from "./test-database.js";
import {
  browserFactory,
  enrollTotp,
  signUpProved,
} from "./trpc/caller.test-helpers.js";

const suffix = randomBytes(6).toString("hex");
const PASSWORD = "correct horse battery staple";

describe("limits and usage", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  const env = {
    AUTH_ENCRYPTION_KEY: keyRing(randomBytes(32)),
    PUBLIC_URL: "https://grid.example.org",
    IMPORT_MAX_ROWS: 500_000,
  } as unknown as Env;
  const hub = {
    closeUser: () => 0,
    closeAllBut: () => 0,
    closeSession: () => 0,
  };
  const browser = browserFactory({ db: () => db, env, hub });
  const admin = browser();
  const member = browser();

  beforeAll(async () => {
    const created = await createTestDatabase("limits_usage");
    db = created.db;
    close = created.close;
    await admin.signUpFirst({
      email: `admin-${suffix}@example.org`,
      displayName: "Ada Admin",
      password: PASSWORD,
    });
    await enrollTotp(admin);
    await admin.call().admin.stepUp({ password: PASSWORD });
    await signUpProved(member, db, {
      email: `member-${suffix}@example.org`,
      displayName: "Mo Member",
      password: PASSWORD,
    });
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  it("lists every limit as kept now, with what the requests of each kind used", async () => {
    // Two addresses sent reports this minute: one past the shipped 30.
    await sql`
      insert into rate_windows ("key", window_start, hits)
      values
        ('198.51.100.1:report', date_bin(interval '1 minute', now(), timestamptz 'epoch'), 31),
        ('2001:db8::1:report', date_bin(interval '1 minute', now(), timestamptz 'epoch'), 4),
        ('198.51.100.1:app', now() - interval '1 hour', 9000)
    `.execute(db);
    const rows = await admin.call().admin.limits();
    const row = (id: string) => rows.find((entry) => entry.id === id);
    expect(row("rate.report")).toMatchObject({
      now: 30,
      bounds: [5, 300],
      used: { most: 31, past: 1 },
    });
    // A window long ended is not what is used now.
    expect(row("rate.app")?.used).toEqual({ most: 0, past: 0 });
    // Fixed by the environment: its value, not the catalogue's.
    expect(row("import.max_rows")).toMatchObject({
      now: 500_000,
      setBy: "environment",
      used: null,
    });
    // Not fixed: set on this page, within its bounds.
    expect(row("export.max_rows")).toMatchObject({
      now: 1_000_000,
      setBy: "limits",
      bounds: [100_000, 10_000_000],
      used: null,
    });
    // Set in Settings: the value the instance keeps, with its bounds.
    expect(row("retention.trash_days")).toMatchObject({
      now: 30,
      setBy: "settings",
      bounds: [7, 365],
      used: null,
    });
    expect(row("jobs.active_per_account")?.used).toEqual({
      most: 0,
      past: 0,
    });
  });

  it("sets a rate within its bounds, which the limiter then reads", async () => {
    await admin.call().admin.updateSettings({ limits: { "rate.report": 60 } });
    expect((await readGateSettings(db)).limits).toEqual({ "rate.report": 60 });
    const rows = await admin.call().admin.limits();
    expect(rows.find((entry) => entry.id === "rate.report")?.used).toEqual({
      most: 31,
      past: 0,
    });
    const trail = await db
      .selectFrom("authEvents")
      .select("detail")
      .where("action", "=", "settings_changed")
      .execute();
    expect(trail.map((event) => event.detail)).toContain("limits");
  });

  it("sets the rows an export writes, which a job then reads, unless the environment fixes them", async () => {
    await admin.call().admin.updateSettings({
      limits: { "rate.report": 60, "export.max_rows": 2_500_000 },
    });
    expect(await exportCeiling(db)).toBe(2_500_000);
    expect(
      (await admin.call().admin.limits()).find(
        (entry) => entry.id === "export.max_rows",
      )?.now,
    ).toBe(2_500_000);
    // The environment's variable wins over the page, and the page may not
    // change what it fixes.
    expect(await importCeiling(db, env)).toBe(500_000);
    await expect(
      admin.call().admin.updateSettings({
        limits: { "rate.report": 60, "import.max_rows": 3_000_000 },
      }),
    ).rejects.toMatchObject({ cause: { code: "set_by_environment" } });
    await admin.call().admin.updateSettings({ limits: { "rate.report": 60 } });
    expect(await exportCeiling(db)).toBe(1_000_000);
  });

  it("refuses a rate past its bounds, a limit set elsewhere, and anyone not an administrator", async () => {
    await expect(
      admin.call().admin.updateSettings({ limits: { "rate.auth": 1 } }),
    ).rejects.toThrow();
    await expect(
      admin.call().admin.updateSettings({
        limits: { "read.rows_per_page": 10 } as never,
      }),
    ).rejects.toThrow();
    await expect(member.call().admin.limits()).rejects.toMatchObject({
      cause: { code: "access_denied" },
    });
    await expect(
      member.call().admin.updateSettings({ limits: { "rate.auth": 40 } }),
    ).rejects.toThrow();
    expect((await readGateSettings(db)).limits).toEqual({ "rate.report": 60 });
  });
});
