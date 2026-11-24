/**
 * What support may do, and to whom (ADR 0054): the helpdesk's acts reach
 * an account that holds no role of Administration. On an administrator, an
 * auditor or another support they would hand support that account.
 */
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminBench } from "./admin-bench.test-helpers.js";
import {
  enrollTotp,
  errorCode,
  signUpProved,
  type TestBrowser,
} from "./caller.test-helpers.js";

const PASSWORD = "correct horse battery staple";

describe("support's reach", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let admin: TestBrowser;
  let helper: TestBrowser;
  const ids = { admin: "", auditor: "", support: "", person: "" };
  const { browser, account, start } = adminBench("support-reach", PASSWORD);
  const sessionsOf = (userId: string) =>
    db
      .selectFrom("sessions")
      .select("id")
      .where("userId", "=", userId)
      .execute();

  beforeAll(async () => {
    const bench = await start();
    ({ db, close, admin } = bench);
    ids.admin = bench.adminId;

    helper = browser();
    const helperId = await signUpProved(helper, db, account("helper"));
    await enrollTotp(helper);
    await admin.call().admin.setSupport({ userId: helperId, support: true });
    await helper.call().admin.stepUp({ password: PASSWORD });

    ids.support = await signUpProved(browser(), db, account("support"));
    await admin.call().admin.setSupport({ userId: ids.support, support: true });
    ids.auditor = await signUpProved(browser(), db, account("auditor"));
    await admin.call().admin.setAuditor({ userId: ids.auditor, auditor: true });
    ids.person = await signUpProved(browser(), db, account("person"));
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  it("refuses every helpdesk act on an account that holds a role of Administration", async () => {
    for (const target of [ids.admin, ids.support, ids.auditor]) {
      const input = { userId: target };
      const api = helper.call().admin;
      for (const attempt of [
        () => api.clearFactors(input),
        () => api.sendPasswordReset(input),
        () => api.unlock(input),
        () => api.unlinkSignOn(input),
        () => api.revokeTokens(input),
        () => api.endUserSessions(input),
      ]) {
        expect(await errorCode(attempt()), target).toBe("account_out_of_reach");
      }
    }
    const [adminSession] = await sessionsOf(ids.admin);
    expect(
      await errorCode(
        helper.call().admin.endSession({ sessionId: adminSession?.id ?? "" }),
      ),
    ).toBe("account_out_of_reach");
    // Nothing of theirs was touched.
    expect(await sessionsOf(ids.admin)).toHaveLength(1);
    expect(
      await db
        .selectFrom("authEvents")
        .select("action")
        .where("userId", "in", [ids.admin, ids.support, ids.auditor])
        .where("action", "in", ["factors_cleared", "password_reset_requested"])
        .execute(),
    ).toEqual([]);
  });

  it("helps an account that holds none", async () => {
    const input = { userId: ids.person };
    const api = helper.call().admin;
    expect(await api.sendPasswordReset(input)).toMatchObject({ sent: false });
    expect(await api.clearFactors(input)).toEqual({ ok: true });
    expect(await api.revokeTokens(input)).toEqual({ count: 0 });
  });

  it("signs out everyone but those who hold a role, when support asks", async () => {
    await signUpProved(browser(), db, account("again"));
    const again = (
      await db
        .selectFrom("users")
        .select("id")
        .where("email", "=", account("again").email)
        .executeTakeFirstOrThrow()
    ).id;
    expect(await sessionsOf(again)).toHaveLength(1);
    await helper.call().admin.endOtherSessions();
    expect(await sessionsOf(again)).toEqual([]);
    expect(await sessionsOf(ids.admin)).toHaveLength(1);
  });

  it("leaves an administrator's reach whole", async () => {
    expect(
      await admin.call().admin.revokeTokens({ userId: ids.auditor }),
    ).toEqual({ count: 0 });
    expect(
      await admin.call().admin.clearFactors({ userId: ids.support }),
    ).toEqual({ ok: true });
  });
});
