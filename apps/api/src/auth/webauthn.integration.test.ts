/**
 * A passkey's answer that does not match is refused as such, against a
 * real database: the library raises on it, and that is no fault of the
 * server.
 */
import { createHash, randomBytes } from "node:crypto";
import type { Database } from "@anygriddb/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../env.js";
import { createTestDatabase } from "../test-database.js";
import {
  beginAuthentication,
  beginRegistration,
  finishAuthentication,
  finishRegistration,
} from "./webauthn.js";

const suffix = randomBytes(6).toString("hex");
const ORIGIN = "https://grid.example.org";
const env = { PUBLIC_URL: ORIGIN } as unknown as Env;

const encoded = (value: Buffer | string) =>
  Buffer.from(value).toString("base64url");

/** What an authenticator signs over: the party's hash, its flags, its counter. */
function authenticatorData(party: string): string {
  return encoded(
    Buffer.concat([
      createHash("sha256").update(party).digest(),
      // The person was there and verified.
      Buffer.from([0x05]),
      Buffer.from([0, 0, 0, 1]),
    ]),
  );
}

describe("a passkey's answer that does not match", () => {
  let db: Database;
  let close: (() => Promise<void>) | undefined;
  let userId = "";
  const credentialId = encoded(randomBytes(16));

  /** A sign-in's answer, forged where `forged` says. */
  const assertion = (
    challenge: string,
    forged: { origin?: string; challenge?: string; party?: string },
  ) =>
    ({
      id: credentialId,
      rawId: credentialId,
      type: "public-key",
      clientExtensionResults: {},
      response: {
        clientDataJSON: encoded(
          JSON.stringify({
            type: "webauthn.get",
            challenge: forged.challenge ?? challenge,
            origin: forged.origin ?? ORIGIN,
          }),
        ),
        authenticatorData: authenticatorData(
          forged.party ?? "grid.example.org",
        ),
        signature: encoded(randomBytes(64)),
      },
    }) as never;

  beforeAll(async () => {
    const created = await createTestDatabase("passkey_forged");
    db = created.db;
    close = created.close;
    userId = (
      await db
        .insertInto("users")
        .values({ email: `ada-${suffix}@example.org`, displayName: "Ada" })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;
    await db
      .insertInto("webauthnCredentials")
      .values({
        userId,
        credentialId,
        publicKey: randomBytes(32),
        counter: 0,
      })
      .execute();
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  it("refuses a sign-in forged in its origin, its challenge, or its party", async () => {
    for (const forged of [
      { origin: "https://evil.example" },
      { challenge: encoded(randomBytes(32)) },
      { party: "evil.example" },
      // Nothing forged but the signature, which no key of ours made.
      {},
    ]) {
      const { challenge } = await beginAuthentication(db, env, userId);
      await expect(
        finishAuthentication(db, env, userId, assertion(challenge, forged)),
      ).rejects.toMatchObject({ code: "webauthn_rejected", status: 401 });
    }
  });

  it("refuses a passkey registered from another origin", async () => {
    const { challenge } = await beginRegistration(db, env, {
      id: userId,
      displayName: "Ada",
    });
    const id = encoded(randomBytes(16));
    await expect(
      finishRegistration(db, env, userId, {
        id,
        rawId: id,
        type: "public-key",
        clientExtensionResults: {},
        response: {
          clientDataJSON: encoded(
            JSON.stringify({
              type: "webauthn.create",
              challenge,
              origin: "https://evil.example",
            }),
          ),
          attestationObject: encoded(randomBytes(64)),
        },
      } as never),
    ).rejects.toMatchObject({ code: "webauthn_rejected", status: 401 });
    // Nothing was kept of it.
    const kept = await db
      .selectFrom("webauthnCredentials")
      .select("credentialId")
      .where("userId", "=", userId)
      .execute();
    expect(kept.map((row) => row.credentialId)).toEqual([credentialId]);
  });
});
