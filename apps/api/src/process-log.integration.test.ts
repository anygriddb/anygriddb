/**
 * Who may read the process log (ADR 0087): an administrator and an
 * auditor, and what the page is given never includes a field a line
 * carried beside the ones it may show.
 */
import { randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keyRing } from "./auth/key-ring.js";
import type { Env } from "./env.js";
import { processLog } from "./process-log.js";
import { createTestDatabase } from "./test-database.js";
import {
  browserFactory,
  enrollTotp,
  errorCode,
  signUpProved,
} from "./trpc/caller.test-helpers.js";

const suffix = randomBytes(6).toString("hex");
const PASSWORD = "correct horse battery staple";
const MARK = `process log probe ${suffix}`;

describe("the process log in Administration", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  const env = {
    AUTH_ENCRYPTION_KEY: keyRing(randomBytes(32)),
    PUBLIC_URL: "https://grid.example.org",
  } as unknown as Env;
  const hub = {
    closeUser: () => 0,
    closeAllBut: () => 0,
    closeSession: () => 0,
  };
  const browser = browserFactory({ db: () => db, env, hub });
  const admin = browser();
  const member = browser();
  const support = browser();
  const auditor = browser();
  const at = (name: string) => `${name}-${suffix}@example.org`;

  beforeAll(async () => {
    const created = await createTestDatabase("processlog");
    db = created.db;
    close = created.close;
    await admin.signUpFirst({
      email: at("admin"),
      displayName: "Ada Admin",
      password: PASSWORD,
    });
    await enrollTotp(admin);
    await signUpProved(member, db, {
      email: at("member"),
      displayName: "Member",
      password: PASSWORD,
    });
    const supportId = await signUpProved(support, db, {
      email: at("support"),
      displayName: "Support",
      password: PASSWORD,
    });
    const auditorId = await signUpProved(auditor, db, {
      email: at("auditor"),
      displayName: "Aud Itor",
      password: PASSWORD,
    });
    await enrollTotp(auditor);
    await admin.call().admin.stepUp({ password: PASSWORD });
    await admin.call().admin.setSupport({ userId: supportId, support: true });
    await admin.call().admin.setAuditor({ userId: auditorId, auditor: true });
    processLog.capture(
      `${JSON.stringify({
        level: 40,
        time: Date.now(),
        msg: MARK,
        password: "s3cret-value",
        req: {
          method: "POST",
          url: "/s/super-secret-token",
          remoteAddress: "203.0.113.9",
        },
      })}\n`,
    );
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  it("shows an administrator the line, without the secret it carried", async () => {
    const { lines } = await admin
      .call()
      .admin.logs({ level: "warn", limit: 100 });
    const got = lines.find((item) => item.message === MARK);
    expect(got).toMatchObject({
      level: "warn",
      message: MARK,
      request: { method: "POST", url: "/s/…", remoteAddress: "203.0.113.9" },
    });
    expect(JSON.stringify(got)).not.toContain("s3cret-value");
    expect(JSON.stringify(got)).not.toContain("super-secret");
  });

  it("refuses a member and a support account", async () => {
    expect(await errorCode(member.call().admin.logs({}))).toBe("access_denied");
    expect(await errorCode(support.call().admin.logs({}))).toBe(
      "access_denied",
    );
  });

  it("keeps a line inside its range and drops one outside it", async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const outside = await admin.call().admin.logs({
      level: "warn",
      from: future,
      limit: 200,
    });
    expect(outside.lines.some((item) => item.message === MARK)).toBe(false);
    expect(outside.total).toBe(0);
    const inside = await admin.call().admin.logs({
      level: "warn",
      to: new Date().toISOString(),
      sort: "message",
      direction: "asc",
      limit: 200,
    });
    expect(inside.lines.some((item) => item.message === MARK)).toBe(true);
    expect(inside.oldest).toEqual(expect.any(String));
  });

  it("lets an auditor read the same line", async () => {
    const { lines } = await auditor
      .call()
      .admin.logs({ level: "warn", limit: 100 });
    expect(lines.some((item) => item.message === MARK)).toBe(true);
  });
});
