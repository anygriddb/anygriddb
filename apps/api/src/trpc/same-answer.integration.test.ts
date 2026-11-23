/**
 * An answer tells nothing to someone who has no right to know it, against a
 * real database: whether an address has an account, and whether an id
 * names anything.
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { keyRing } from "../auth/key-ring.js";
import type { Env } from "../env.js";
import { createTestDatabase } from "../test-database.js";
import {
  browserFactory,
  enrollTotp,
  errorCode as code,
  signUpProved,
} from "./caller.test-helpers.js";

const suffix = randomBytes(6).toString("hex");
const PASSWORD = "correct horse battery staple";

describe("the same answer, whoever and whatever exists", () => {
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
  const owner = browser();
  const member = browser();
  const stranger = browser();
  const at = (name: string) => `${name}-${suffix}@example.org`;
  let baseId = "";
  let tableId = "";
  let memberId = "";
  let strangerId = "";

  const roleOf = async (userId: string) =>
    (
      await db
        .selectFrom("roleBindings")
        .select("role")
        .where("userId", "=", userId)
        .where("scope", "=", "base")
        .where("scopeId", "=", baseId)
        .executeTakeFirst()
    )?.role ?? null;

  beforeAll(async () => {
    const created = await createTestDatabase("same_answer");
    db = created.db;
    close = created.close;
    await owner.signUpFirst({
      email: at("owner"),
      displayName: "Olive Owner",
      password: PASSWORD,
    });
    await enrollTotp(owner);
    baseId = (await owner.call().catalog.createBase({ name: "Ledger" })).id;
    tableId = (
      await owner.call().catalog.createTable({
        baseId,
        name: "Samples",
        columns: [{ name: "title", label: "Title", fieldType: "text" }],
      })
    ).id;
    memberId = await signUpProved(member, db, {
      email: at("member"),
      displayName: "Mel Member",
      password: PASSWORD,
    });
    strangerId = await signUpProved(stranger, db, {
      email: at("stranger"),
      displayName: "Sam Stranger",
      password: PASSWORD,
    });
    // The member joins as anyone does: invited, then changed at once.
    await owner.call().catalog.invite({
      baseId,
      email: at("member"),
      role: "viewer",
    });
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  it("gives a role at once to a member only, and refuses any other address alike", async () => {
    const grant = (email: string) =>
      code(owner.call().catalog.grant({ baseId, email, role: "editor" }));
    // An account that is not of the base, and an address nobody has.
    expect(await grant(at("stranger"))).toBe("not_a_member");
    expect(await grant(at("nobody"))).toBe("not_a_member");
    expect(await roleOf(strangerId)).toBeNull();
    // Inviting them answers alike too, and gives nothing before they accept.
    const invited = await Promise.all(
      [at("stranger"), at("nobody")].map(async (email) => {
        const answer = await owner
          .call()
          .catalog.invite({ baseId, email, role: "editor" });
        return answer.status;
      }),
    );
    expect(invited).toEqual(["invited", "invited"]);
    expect(await roleOf(strangerId)).toBeNull();
  });

  it("changes the role of someone the base counts", async () => {
    const invitation = await db
      .selectFrom("invitations")
      .select("id")
      .where("baseId", "=", baseId)
      .where("email", "=", at("member"))
      .executeTakeFirstOrThrow();
    await member
      .call()
      .auth.answerInvitation({ invitationId: invitation.id, accept: true });
    expect(await roleOf(memberId)).toBe("viewer");
    expect(
      await code(
        owner
          .call()
          .catalog.grant({ baseId, email: at("member"), role: "editor" }),
      ),
    ).toBe("ok");
    expect(await roleOf(memberId)).toBe("editor");
  });

  it("refuses a base or a table that is not there as one the caller has no role on", async () => {
    const answers = async (page: typeof stranger, id: string) => [
      await code(page.call().rows.read({ tableId: id })),
      await code(page.call().catalog.members({ baseId: id })),
    ];
    // To someone with no role, an id that names something and one that
    // names nothing answer alike.
    expect(await answers(stranger, randomUUID())).toEqual([
      "access_denied",
      "access_denied",
    ]);
    expect([
      await code(stranger.call().rows.read({ tableId })),
      await code(stranger.call().catalog.members({ baseId })),
    ]).toEqual(["access_denied", "access_denied"]);
    // The owner reads what is there, and is told the same of what is not.
    expect(await code(owner.call().rows.read({ tableId }))).toBe("ok");
    expect(await answers(owner, randomUUID())).toEqual([
      "access_denied",
      "access_denied",
    ]);
  });

  it("says the same of an account that is not there and of one the table does not count", async () => {
    const seen = (userId: string) =>
      code(owner.call().catalog.viewAs({ tableId, userId }));
    expect(await seen(randomUUID())).toBe("unknown_account");
    expect(await seen(strangerId)).toBe("unknown_account");
    expect(await seen(memberId)).toBe("ok");
  });

  it("locks an address with no account as it locks an account", async () => {
    const attempts = async (email: string) => {
      const page = browser();
      const answers: string[] = [];
      for (let attempt = 0; attempt < 12; attempt += 1) {
        answers.push(
          await code(page.call().auth.login({ email, password: "not it" })),
        );
      }
      return answers;
    };
    const known = await attempts(at("stranger"));
    // Ten failures by the instance's default, then the lock.
    expect(known).toEqual([
      ...Array.from({ length: 10 }, () => "invalid_credentials"),
      "account_locked",
      "account_locked",
    ]);
    expect(await attempts(at("nobody-at-all"))).toEqual(known);
    // Whatever the letters' case, it is the same address.
    expect(
      await code(
        browser()
          .call()
          .auth.login({
            email: at("nobody-at-all").toUpperCase(),
            password: "not it",
          }),
      ),
    ).toBe("account_locked");
    // An address not tried yet is not locked by the others.
    expect(
      await code(
        browser()
          .call()
          .auth.login({ email: at("someone-else"), password: "not it" }),
      ),
    ).toBe("invalid_credentials");
  });
});
