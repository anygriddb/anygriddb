import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { Database } from "@anygriddb/db";
import type { Env } from "../env.js";
import { relyingParty } from "./relying-party.js";
import { AppError } from "@anygriddb/core";

const CEREMONY_TTL_MS = 5 * 60 * 1000;

export type StoredWebAuthnCredential = {
  userId: string;
  credentialId: string;
  publicKey: Buffer;
  counter: number;
};

async function storeChallenge(
  db: Database,
  userId: string,
  challenge: string,
  kind: "register" | "authenticate",
): Promise<void> {
  await db.transaction().execute(async (tx) => {
    await tx
      .deleteFrom("webauthnChallenges")
      .where("userId", "=", userId)
      .where("kind", "=", kind)
      .execute();
    await tx
      .insertInto("webauthnChallenges")
      .values({
        userId,
        challenge,
        kind,
        expiresAt: new Date(Date.now() + CEREMONY_TTL_MS),
      })
      .execute();
  });
}

async function takeChallenge(
  db: Database,
  userId: string,
  kind: "register" | "authenticate",
): Promise<string> {
  // One statement takes the challenge: a replayed response finds none.
  const row = await db
    .deleteFrom("webauthnChallenges")
    .where("userId", "=", userId)
    .where("kind", "=", kind)
    .where("expiresAt", ">", new Date())
    .returning("challenge")
    .executeTakeFirst();
  if (!row) {
    throw new AppError("challenge_expired");
  }
  return row.challenge;
}

export async function saveWebAuthnCredential(
  db: Database,
  credential: StoredWebAuthnCredential,
): Promise<void> {
  await db.insertInto("webauthnCredentials").values(credential).execute();
}

export async function beginRegistration(
  db: Database,
  env: Env,
  user: { id: string; displayName: string },
) {
  const party = relyingParty(env.PUBLIC_URL);
  const existing = await db
    .selectFrom("webauthnCredentials")
    .select("credentialId")
    .where("userId", "=", user.id)
    .execute();
  const options = await generateRegistrationOptions({
    rpName: "AnyGridDB",
    rpID: party.rpID,
    userName: user.displayName,
    userDisplayName: user.displayName,
    userID: new TextEncoder().encode(user.id),
    attestationType: "none",
    excludeCredentials: existing.map((row) => ({ id: row.credentialId })),
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "required",
    },
  });
  await storeChallenge(db, user.id, options.challenge, "register");
  return options;
}

export async function finishRegistration(
  db: Database,
  env: Env,
  userId: string,
  response: RegistrationResponseJSON,
): Promise<void> {
  const party = relyingParty(env.PUBLIC_URL);
  const expectedChallenge = await takeChallenge(db, userId, "register");
  let credential: { id: string; publicKey: Uint8Array; counter: number };
  try {
    const result = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: party.origin,
      expectedRPID: party.rpID,
      requireUserVerification: true,
    });
    if (!result.verified) {
      throw new AppError("webauthn_rejected");
    }
    credential = result.registrationInfo.credential;
  } catch (error) {
    if (error instanceof Error && error.message === "WebAuthn rejected") {
      throw error;
    }
    throw new Error("WebAuthn rejected", { cause: error });
  }
  await saveWebAuthnCredential(db, {
    userId,
    credentialId: credential.id,
    publicKey: Buffer.from(credential.publicKey),
    counter: credential.counter,
  });
}

export async function beginAuthentication(
  db: Database,
  env: Env,
  userId: string,
) {
  const party = relyingParty(env.PUBLIC_URL);
  const existing = await db
    .selectFrom("webauthnCredentials")
    .select("credentialId")
    .where("userId", "=", userId)
    .execute();
  if (existing.length === 0) {
    throw new AppError("webauthn_rejected");
  }
  const options = await generateAuthenticationOptions({
    rpID: party.rpID,
    allowCredentials: existing.map((row) => ({ id: row.credentialId })),
    userVerification: "required",
  });
  await storeChallenge(db, userId, options.challenge, "authenticate");
  return options;
}

export async function finishAuthentication(
  db: Database,
  env: Env,
  userId: string,
  response: AuthenticationResponseJSON,
): Promise<void> {
  const party = relyingParty(env.PUBLIC_URL);
  const expectedChallenge = await takeChallenge(db, userId, "authenticate");
  const stored = await db
    .selectFrom("webauthnCredentials")
    .selectAll()
    .where("userId", "=", userId)
    .where("credentialId", "=", response.id)
    .executeTakeFirst();
  if (!stored) {
    throw new AppError("webauthn_rejected");
  }
  let nextCounter: number;
  try {
    const result = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: party.origin,
      expectedRPID: party.rpID,
      requireUserVerification: true,
      credential: {
        id: stored.credentialId,
        publicKey: new Uint8Array(stored.publicKey),
        counter: stored.counter,
      },
    });
    if (!result.verified) {
      throw new AppError("webauthn_rejected");
    }
    nextCounter = result.authenticationInfo.newCounter;
  } catch (error) {
    if (error instanceof Error && error.message === "WebAuthn rejected") {
      throw error;
    }
    throw new Error("WebAuthn rejected", { cause: error });
  }
  if (stored.counter > 0 && nextCounter <= stored.counter) {
    throw new AppError("webauthn_rejected");
  }
  await db
    .updateTable("webauthnCredentials")
    .set({ counter: nextCounter })
    .where("id", "=", stored.id)
    .execute();
}
