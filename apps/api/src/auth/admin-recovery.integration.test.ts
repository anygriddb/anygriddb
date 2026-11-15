/**
 * An operator's way back in (ADR 0082), against a real database: one
 * account made an active administrator with a link to its password, its
 * second factors kept unless asked, the list of sign-in addresses emptied
 * only when asked, every change on the sign-in trail as done from the
 * command line, and nothing done for an address it must not touch.
 */
import { randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ERASED_USER_ID } from "../data/erasure.js";
import { readSettings, writeSettings } from "../settings.js";
import { createTestDatabase } from "../test-database.js";
import {
  recoverAdministrator,
  type RecoveryRefusal,
  RecoveryRefused,
} from "./admin-recovery.js";
import {
  findResetLink,
  hasPassword,
  resetPassword,
  SELF_RESET_TTL_MS,
} from "./password-reset.js";

const suffix = randomBytes(6).toString("hex");
const address = (name: string) => `${name}-${suffix}@example.org`;

describe("an operator's way back in", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;

  async function refusal(
    input: Parameters<typeof recoverAdministrator>[1],
  ): Promise<RecoveryRefusal | "done"> {
    try {
      await recoverAdministrator(db, input);
      return "done";
    } catch (error) {
      if (error instanceof RecoveryRefused) return error.reason;
      throw error;
    }
  }

  async function account(
    name: string,
    values: { isAdmin?: boolean; disabled?: boolean } = {},
  ): Promise<string> {
    const row = await db
      .insertInto("users")
      .values({
        email: address(name),
        displayName: name,
        isAdmin: values.isAdmin ?? false,
        ...(values.disabled
          ? { disabledAt: new Date(), disabledReason: "admin" }
          : {}),
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    return row.id;
  }

  /** The command's events about one account, oldest first. */
  async function trail(userId: string | null) {
    const rows = await db
      .selectFrom("authEvents")
      .select(["action", "method", "detail", "actorId"])
      .where("method", "=", "command")
      .$if(userId !== null, (query) => query.where("userId", "=", userId))
      .$if(userId === null, (query) => query.where("userId", "is", null))
      .orderBy("id", "asc")
      .execute();
    // Nobody was signed in: no event names an author.
    for (const row of rows) expect(row.actorId).toBeNull();
    return rows.map((row) =>
      row.detail ? `${row.action}:${row.detail}` : row.action,
    );
  }

  const accountOf = (userId: string) =>
    db
      .selectFrom("users")
      .select(["isAdmin", "disabledAt", "disabledReason"])
      .where("id", "=", userId)
      .executeTakeFirstOrThrow();

  beforeAll(async () => {
    const created = await createTestDatabase("admin_recovery");
    db = created.db;
    close = created.close;
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  it("does nothing for an instance that has no account yet", async () => {
    expect(await refusal({ email: address("nobody"), create: "Nobody" })).toBe(
      "no_accounts",
    );
    const accounts = await db
      .selectFrom("users")
      .select("id")
      .where("id", "<>", ERASED_USER_ID)
      .execute();
    expect(accounts).toEqual([]);
  });

  it("makes a disabled member an active administrator, and keeps its second factor", async () => {
    const userId = await account("member", { disabled: true });
    await db
      .insertInto("totpSecrets")
      .values({
        userId,
        ciphertext: Buffer.from("sealed"),
        nonce: Buffer.from("nonce"),
      })
      .execute();
    const before = Date.now();
    const done = await recoverAdministrator(db, { email: address("MEMBER") });
    expect(done.userId).toBe(userId);
    expect(done.changed).toEqual(["admin", "enabled"]);
    expect(await accountOf(userId)).toEqual({
      isAdmin: true,
      disabledAt: null,
      disabledReason: null,
    });
    // The link alone does not open an account that has a factor.
    const factor = await db
      .selectFrom("totpSecrets")
      .select("userId")
      .where("userId", "=", userId)
      .executeTakeFirst();
    expect(factor).toBeDefined();
    expect(done.link.expiresAt.getTime()).toBeGreaterThanOrEqual(
      before + SELF_RESET_TTL_MS,
    );
    expect(await trail(userId)).toEqual([
      "account_updated:admin_granted",
      "account_updated:enabled",
      "password_reset_requested",
    ]);

    // The link sets the password, once.
    expect(await hasPassword(db, userId)).toBe(false);
    await resetPassword(db, done.link.token, "correct horse battery staple", {
      passwordMinLength: 12,
    });
    expect(await hasPassword(db, userId)).toBe(true);
    expect(await findResetLink(db, done.link.token)).toBeNull();
  });

  it("changes nothing the second time, and replaces the link", async () => {
    const first = await recoverAdministrator(db, { email: address("member") });
    expect(first.changed).toEqual([]);
    const second = await recoverAdministrator(db, { email: address("member") });
    expect(second.changed).toEqual([]);
    expect(second.link.token).not.toBe(first.link.token);
    expect(await findResetLink(db, first.link.token)).toBeNull();
    expect(await findResetLink(db, second.link.token)).toMatchObject({
      userId: second.userId,
    });
  });

  it("removes the second factors and sessions only when asked, and says when there were none", async () => {
    const userId = await account("factors", { isAdmin: true });
    await db
      .insertInto("totpSecrets")
      .values({
        userId,
        ciphertext: Buffer.from("sealed"),
        nonce: Buffer.from("nonce"),
      })
      .execute();
    await db
      .insertInto("backupCodes")
      .values({ userId, codeHash: `code-${suffix}` })
      .execute();
    await db
      .insertInto("sessions")
      .values({
        userId,
        tokenHash: `session-${suffix}`,
        expiresAt: new Date(Date.now() + 60_000),
      })
      .execute();
    const done = await recoverAdministrator(db, {
      email: address("factors"),
      clearFactors: true,
    });
    expect(done.changed).toEqual(["factors"]);
    for (const table of ["totpSecrets", "backupCodes", "sessions"] as const) {
      const left = await db
        .selectFrom(table)
        .select("userId")
        .where("userId", "=", userId)
        .execute();
      expect(left).toEqual([]);
    }
    expect(await trail(userId)).toEqual([
      "factors_cleared",
      "password_reset_requested",
    ]);
    const again = await recoverAdministrator(db, {
      email: address("factors"),
      clearFactors: true,
    });
    expect(again.changed).toEqual([]);
  });

  it("makes an account only when asked, as an administrator", async () => {
    expect(await refusal({ email: address("new") })).toBe("unknown_address");
    expect(
      await db
        .selectFrom("users")
        .select("id")
        .where("email", "=", address("new"))
        .executeTakeFirst(),
    ).toBeUndefined();

    const done = await recoverAdministrator(db, {
      email: address("New"),
      create: "Nell New",
    });
    expect(done.changed).toEqual(["created"]);
    const made = await db
      .selectFrom("users")
      .select(["email", "displayName", "isAdmin", "disabledAt"])
      .where("id", "=", done.userId)
      .executeTakeFirstOrThrow();
    expect(made).toEqual({
      email: address("new"),
      displayName: "Nell New",
      isAdmin: true,
      disabledAt: null,
    });
    expect(await trail(done.userId)).toEqual([
      "account_created:as_admin",
      "password_reset_requested",
    ]);
    expect(await findResetLink(db, done.link.token)).toMatchObject({
      userId: done.userId,
    });
  });

  it("leaves alone an account its identity provider signs in", async () => {
    const userId = await account("provided");
    await db
      .insertInto("ssoIdentities")
      .values({
        provider: "oidc",
        issuer: "https://id.example.org",
        subject: `subject-${suffix}`,
        userId,
      })
      .execute();
    expect(
      await refusal({ email: address("provided"), clearFactors: true }),
    ).toBe("provider_account");
    expect((await accountOf(userId)).isAdmin).toBe(false);
    expect(await trail(userId)).toEqual([]);
  });

  it("never opens the account erased people become", async () => {
    const erased = await db
      .selectFrom("users")
      .select("email")
      .where("id", "=", ERASED_USER_ID)
      .executeTakeFirstOrThrow();
    expect(await refusal({ email: erased.email, create: "Someone" })).toBe(
      "reserved_address",
    );
    expect((await accountOf(ERASED_USER_ID)).isAdmin).toBe(false);
  });

  it("empties the list of sign-in addresses only when asked", async () => {
    const adminId = await account("lister", { isAdmin: true });
    await writeSettings(db, adminId, {
      signInAllowlist: ["192.0.2.0/24", "2001:db8::/32"],
    });
    const kept = await recoverAdministrator(db, { email: address("lister") });
    expect(kept.changed).toEqual([]);
    expect(kept.addressRanges).toBe(2);
    expect((await readSettings(db)).signInAllowlist).toHaveLength(2);

    const opened = await recoverAdministrator(db, {
      email: address("lister"),
      anyAddress: true,
    });
    expect(opened.changed).toEqual(["addresses"]);
    expect(opened.addressRanges).toBe(0);
    expect((await readSettings(db)).signInAllowlist).toEqual([]);
    expect(await trail(null)).toEqual(["settings_changed:signInAllowlist"]);

    // Nothing to empty: nothing said, nothing written.
    const again = await recoverAdministrator(db, {
      email: address("lister"),
      anyAddress: true,
    });
    expect(again.changed).toEqual([]);
    expect(await trail(null)).toEqual(["settings_changed:signInAllowlist"]);
  });

  it("refuses what is no address or no name", async () => {
    await expect(
      recoverAdministrator(db, { email: "not an address" }),
    ).rejects.toThrow();
    await expect(
      recoverAdministrator(db, { email: address("named"), create: " " }),
    ).rejects.toThrow();
  });
});
