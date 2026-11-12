/**
 * A role given to an address: the answer is the same whether or not the
 * address has an account, and an account's holder answers the invitation
 * from their own list.
 */
import { randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../env.js";
import { createTestDatabase } from "../test-database.js";
import {
  browserFactory,
  enrollTotp,
  errorCode,
  signUpProved,
} from "../trpc/caller.test-helpers.js";

const suffix = randomBytes(6).toString("hex");
const PASSWORD = "correct horse battery staple";

describe("invitations", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  const env = {
    AUTH_ENCRYPTION_KEY: randomBytes(32),
    PUBLIC_URL: "https://grid.example.org",
  } as unknown as Env;
  const hub = {
    closeUser: () => 0,
    closeAllBut: () => 0,
    closeSession: () => 0,
  };
  const browser = browserFactory({ db: () => db, env, hub });
  const owner = browser();
  const ben = browser();
  const benEmail = `ben-${suffix}@example.org`;
  let baseId = "";
  let otherBaseId = "";

  const roleOf = async (email: string, base: string) =>
    (
      await db
        .selectFrom("roleBindings as b")
        .innerJoin("users as u", "u.id", "b.userId")
        .select("b.role")
        .where("u.email", "=", email)
        .where("b.scope", "=", "base")
        .where("b.scopeId", "=", base)
        .executeTakeFirst()
    )?.role;

  beforeAll(async () => {
    const created = await createTestDatabase("invitations");
    db = created.db;
    close = created.close;
    await owner.call().auth.signup({
      email: `owner-${suffix}@example.org`,
      displayName: "Olive Owner",
      password: PASSWORD,
    });
    await enrollTotp(owner);
    baseId = (await owner.call().catalog.createBase({ name: "Lab" })).id;
    otherBaseId = (await owner.call().catalog.createBase({ name: "Archive" }))
      .id;
    await signUpProved(ben, db, {
      email: benEmail,
      displayName: "Ben",
      password: PASSWORD,
    });
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  it("answers alike for an address with an account and one without", async () => {
    const known = await owner
      .call()
      .catalog.invite({ baseId, email: benEmail, role: "viewer" });
    const unknown = await owner.call().catalog.invite({
      baseId,
      email: `nobody-${suffix}@example.org`,
      role: "viewer",
    });
    expect({ status: known.status, mailed: known.mailed }).toEqual({
      status: unknown.status,
      mailed: unknown.mailed,
    });
    expect(known.status).toBe("invited");
    expect(typeof known.token).toBe(typeof unknown.token);
    // Nothing is given before the person answers.
    expect(await roleOf(benEmail, baseId)).toBeUndefined();
  });

  it("lets the account's holder accept from their own list, with no link", async () => {
    const { invitations } = await ben.call().auth.pendingInvitations();
    expect(invitations).toHaveLength(1);
    expect(invitations[0]).toMatchObject({
      baseName: "Lab",
      role: "viewer",
      invitedBy: "Olive Owner",
    });
    const id = invitations[0]?.id ?? "";
    expect(
      await ben
        .call()
        .auth.answerInvitation({ invitationId: id, accept: true }),
    ).toEqual({ baseId });
    expect(await roleOf(benEmail, baseId)).toBe("viewer");
    expect((await ben.call().auth.pendingInvitations()).invitations).toEqual(
      [],
    );
    expect(
      (await ben.call().catalog.list()).some((base) => base.id === baseId),
    ).toBe(true);
  });

  it("changes the role of someone already in the base at once", async () => {
    expect(
      await owner
        .call()
        .catalog.invite({ baseId, email: benEmail, role: "editor" }),
    ).toMatchObject({ status: "granted" });
    expect(await roleOf(benEmail, baseId)).toBe("editor");
  });

  it("refuses an invitation to anyone but its address, and lets it be declined", async () => {
    await owner
      .call()
      .catalog.invite({ baseId: otherBaseId, email: benEmail, role: "editor" });
    const id =
      (await ben.call().auth.pendingInvitations()).invitations[0]?.id ?? "";
    // The owner holds another address: Ben's invitation is not theirs.
    expect((await owner.call().auth.pendingInvitations()).invitations).toEqual(
      [],
    );
    expect(
      await errorCode(
        owner.call().auth.answerInvitation({ invitationId: id, accept: true }),
      ),
    ).toBe("invalid_invitation");
    expect(await roleOf(benEmail, otherBaseId)).toBeUndefined();

    expect(
      await ben
        .call()
        .auth.answerInvitation({ invitationId: id, accept: false }),
    ).toEqual({ baseId: null });
    expect(await roleOf(benEmail, otherBaseId)).toBeUndefined();
    expect(
      await errorCode(
        ben.call().auth.answerInvitation({ invitationId: id, accept: true }),
      ),
    ).toBe("invalid_invitation");
  });
});
