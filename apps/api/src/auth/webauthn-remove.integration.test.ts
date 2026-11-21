/**
 * A person takes a passkey off their own account, against a real database.
 */
import { randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase } from "../test-database.js";
import { factorMethods } from "./access.js";
import { hasBackupCodes, replaceBackupCodes } from "./backup-store.js";
import { listPasskeys, removePasskey } from "./webauthn.js";

const suffix = randomBytes(6).toString("hex");

describe("removing a passkey", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let ada = "";
  let bob = "";

  const person = async (name: string) =>
    (
      await db
        .insertInto("users")
        .values({
          email: `${name}-${suffix}@example.org`,
          displayName: name,
        })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;

  const passkey = async (userId: string) =>
    (
      await db
        .insertInto("webauthnCredentials")
        .values({
          userId,
          credentialId: randomBytes(16).toString("base64url"),
          publicKey: randomBytes(32),
          counter: 0,
        })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;

  beforeAll(async () => {
    const created = await createTestDatabase("passkey_remove");
    db = created.db;
    close = created.close;
    ada = await person("ada");
    bob = await person("bob");
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  it("lists when each came, and never its key", async () => {
    const id = await passkey(ada);
    const listed = await listPasskeys(db, ada);
    expect(listed.map((row) => row.id)).toEqual([id]);
    expect(Object.keys(listed[0] ?? {}).sort()).toEqual(["createdAt", "id"]);
    expect(await listPasskeys(db, bob)).toEqual([]);
    await removePasskey(db, ada, id);
  });

  it("refuses another person's passkey, and leaves it", async () => {
    const theirs = await passkey(bob);
    await expect(removePasskey(db, ada, theirs)).rejects.toMatchObject({
      code: "not_found",
    });
    expect((await listPasskeys(db, bob)).map((row) => row.id)).toEqual([
      theirs,
    ]);
    await removePasskey(db, bob, theirs);
  });

  it("keeps the backup codes while another factor remains", async () => {
    const first = await passkey(ada);
    const second = await passkey(ada);
    await replaceBackupCodes(db, ada, ["hash-one", "hash-two"]);
    await removePasskey(db, ada, first);
    expect(await factorMethods(db, ada)).toEqual(["webauthn"]);
    expect(await hasBackupCodes(db, ada)).toBe(true);

    await removePasskey(db, ada, second);
    expect(await factorMethods(db, ada)).toEqual([]);
    expect(await hasBackupCodes(db, ada)).toBe(false);
  });

  it("is written in the sign-in trail, as the person's own", async () => {
    const id = await passkey(ada);
    await removePasskey(db, ada, id, "192.0.2.10");
    const event = await db
      .selectFrom("authEvents")
      .select(["action", "actorId", "method", "detail"])
      .where("userId", "=", ada)
      .orderBy("id", "desc")
      .executeTakeFirstOrThrow();
    expect(event).toEqual({
      action: "factors_cleared",
      actorId: ada,
      method: "webauthn",
      detail: "self_service",
    });
  });
});
