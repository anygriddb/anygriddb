/**
 * The parts of Administration an administrator gives apart (ROADMAP #34,
 * ADR 0126): an account manager and a source manager, each held to its
 * part, and neither able to climb out of it.
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
const NOWHERE = "00000000-0000-4000-8000-00000000abcd";

describe("delegated administration", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let admin: TestBrowser;
  let accounts: TestBrowser;
  let sources: TestBrowser;
  const ids = { admin: "", accounts: "", sources: "", person: "" };
  const { suffix, browser, account, start } = adminBench(
    "delegated-admin",
    PASSWORD,
  );
  const trail = (userId: string, detail: string) =>
    db
      .selectFrom("authEvents")
      .select(["actorId"])
      .where("action", "=", "account_updated")
      .where("userId", "=", userId)
      .where("detail", "=", detail)
      .execute();

  beforeAll(async () => {
    const bench = await start();
    ({ db, close, admin } = bench);
    ids.admin = bench.adminId;
    accounts = browser();
    ids.accounts = await signUpProved(accounts, db, account("accounts"));
    sources = browser();
    ids.sources = await signUpProved(sources, db, account("sources"));
    // Making a base of its own asks for a second factor (ADR 0043).
    await enrollTotp(sources);
    ids.person = await signUpProved(browser(), db, account("person"));
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  it("is given by an administrator alone, on the sign-in trail", async () => {
    expect(
      await errorCode(
        accounts.call().admin.setInstanceRole({
          userId: ids.accounts,
          role: "account_manager",
          granted: true,
        }),
      ),
    ).toBe("access_denied");
    for (const [userId, role] of [
      [ids.accounts, "account_manager"],
      [ids.sources, "source_manager"],
    ] as const) {
      await admin.call().admin.setInstanceRole({ userId, role, granted: true });
      // Given again, nothing changed: the trail is told once.
      await admin.call().admin.setInstanceRole({ userId, role, granted: true });
      expect(await trail(userId, `${role}_granted`)).toEqual([
        { actorId: ids.admin },
      ]);
    }
    const page = await admin.call().admin.account({ userId: ids.accounts });
    expect(page.instanceRoles).toEqual(["account_manager"]);
    expect((await accounts.call().session.current())?.instanceRoles).toEqual([
      "account_manager",
    ]);
  });

  it("asks an account manager for the proof, then lets it make people", async () => {
    const person = {
      email: `made-${suffix}@example.org`,
      displayName: "Made",
    };
    expect(await errorCode(accounts.call().admin.createAccount(person))).toBe(
      "step_up_required",
    );
    await accounts.call().admin.stepUp({ password: PASSWORD });
    const made = await accounts.call().admin.createAccount(person);
    expect(made.userId).toMatch(/^[0-9a-f-]{36}$/);
    expect(
      (await accounts.call().admin.users({})).users.some(
        (user) => user.id === made.userId,
      ),
    ).toBe(true);
    const group = await accounts
      .call()
      .admin.groups.create({ displayName: `Team ${suffix}` });
    await accounts
      .call()
      .admin.groups.addMember({ groupId: group.id, userId: ids.person });
    await accounts.call().admin.updateAccount({
      userId: ids.person,
      displayName: "Person, renamed",
      email: account("person").email,
    });
  });

  it("never lets an account manager make an administrator, a member, or climb", async () => {
    const api = accounts.call().admin;
    expect(
      await errorCode(
        api.createAccount({
          email: `boss-${suffix}@example.org`,
          displayName: "Boss",
          admin: true,
        }),
      ),
    ).toBe("access_denied");
    const baseId = (await admin.call().catalog.createBase({ name: "Pay" })).id;
    expect(
      await errorCode(
        api.createAccount({
          email: `member-${suffix}@example.org`,
          displayName: "Member",
          memberships: [{ baseId, role: "owner" }],
        }),
      ),
    ).toBe("access_denied");
    const group = await api.groups.create({ displayName: `Pay ${suffix}` });
    for (const attempt of [
      () =>
        api.groups.setBaseRole({ groupId: group.id, baseId, role: "owner" }),
      () => api.setAdmin({ userId: ids.accounts, admin: true }),
      () =>
        api.setInstanceRole({
          userId: ids.person,
          role: "source_manager",
          granted: true,
        }),
      () => api.startActing({ userId: ids.person, reason: "look" }),
      () => api.settings(),
      () => api.sources.list(),
      () => api.eraseInfo({ userId: ids.person }),
    ]) {
      expect(await errorCode(attempt())).toBe("access_denied");
    }
    // An account that holds a role of Administration is out of its reach.
    for (const target of [ids.admin, ids.sources]) {
      expect(
        await errorCode(api.setDisabled({ userId: target, disabled: true })),
      ).toBe("account_out_of_reach");
      expect(
        await errorCode(
          api.updateAccount({
            userId: target,
            displayName: "Taken",
            email: `taken-${suffix}@example.org`,
          }),
        ),
      ).toBe("account_out_of_reach");
      expect(await errorCode(api.clearFactors({ userId: target }))).toBe(
        "account_out_of_reach",
      );
    }
    expect(
      await api.disableAccounts({ userIds: [ids.admin, ids.sources] }),
    ).toEqual({ disabled: 0, refused: 2 });
    const still = await db
      .selectFrom("users")
      .select(["email", "disabledAt"])
      .where("id", "in", [ids.admin, ids.sources])
      .execute();
    expect(still.every((user) => user.disabledAt === null)).toBe(true);
    expect(still.some((user) => user.email.startsWith("taken-"))).toBe(false);
  });

  it("holds a source manager to the sources, and to the bases it owns", async () => {
    await sources.call().admin.stepUp({ password: PASSWORD });
    expect(Array.isArray(await sources.call().admin.sources.list())).toBe(true);
    for (const attempt of [
      () => sources.call().admin.users({}),
      () => sources.call().admin.groups.list(),
      () =>
        sources.call().admin.createAccount({
          email: `other-${suffix}@example.org`,
          displayName: "Other",
        }),
    ]) {
      expect(await errorCode(attempt())).toBe("access_denied");
    }
    const theirs = (await admin.call().catalog.createBase({ name: "Theirs" }))
      .id;
    const tables = [{ schema: "public", name: "orders" }];
    expect(
      await errorCode(
        sources.call().admin.sources.expose({
          sourceId: NOWHERE,
          baseId: theirs,
          tables,
        }),
      ),
    ).toBe("access_denied");
    const own = (await sources.call().catalog.createBase({ name: "Own" })).id;
    // Its own base passes; the source then is what is missing.
    expect(
      await errorCode(
        sources.call().admin.sources.expose({
          sourceId: NOWHERE,
          baseId: own,
          tables,
        }),
      ),
    ).toBe("unknown_source");
  });

  it("keeps an administrator from acting as one who holds a part", async () => {
    expect(
      await errorCode(
        admin
          .call()
          .admin.startActing({ userId: ids.accounts, reason: "check" }),
      ),
    ).toBe("cannot_act_as");
  });

  it("takes the part away, and the calls with it", async () => {
    await admin.call().admin.setInstanceRole({
      userId: ids.sources,
      role: "source_manager",
      granted: false,
    });
    expect(await trail(ids.sources, "source_manager_revoked")).toHaveLength(1);
    expect(await errorCode(sources.call().admin.sources.list())).toBe(
      "access_denied",
    );
  });
});
