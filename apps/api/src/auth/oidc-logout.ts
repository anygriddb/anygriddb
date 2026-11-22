/**
 * OIDC Back-Channel Logout: the provider tells the instance a person's
 * session ended there, by posting a signed logout token. The token proves
 * who sent it, for which client, and that it is a logout and nothing else;
 * it ends the sessions that provider opened, and no other.
 */
import { AppError } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { jwtVerify, type JWTVerifyGetKey } from "jose";
import { recordAuthEvent } from "./auth-events.js";
import { encryptSecret } from "./crypto.js";
import type { KeyRing } from "./key-ring.js";
import { hashSessionToken } from "./session.js";
import { isUniqueViolation } from "../data/schema-ops.js";

const LOGOUT_EVENT = "http://schemas.openid.net/event/backchannel-logout";
/** Public-key signatures only: a shared secret would let a client forge one. */
const ALGORITHMS = [
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "PS384",
  "PS512",
  "ES256",
  "ES384",
  "ES512",
  "EdDSA",
];
const MAX_TOKEN_LENGTH = 8_192;
const MAX_TOKEN_AGE_S = 300;
/** Longer than a token is accepted: it cannot come back once forgotten. */
const SPENT_FOR_MS = 2 * MAX_TOKEN_AGE_S * 1000;

/** How a provider's session is kept: bound to its issuer, never in clear. */
export function hashProviderSession(issuer: string, sid: string): string {
  return hashSessionToken(`${issuer} ${sid}`);
}

type LogoutClaims = { jti: string; subject?: string; sid?: string };

/** The logout token's claims, or a refusal, whatever is wrong with it. */
export async function verifyLogoutToken(
  token: unknown,
  expected: { issuer: string; clientId: string; keys: JWTVerifyGetKey },
): Promise<LogoutClaims> {
  if (typeof token !== "string" || token.length > MAX_TOKEN_LENGTH) {
    throw new AppError("invalid_credentials");
  }
  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(token, expected.keys, {
      issuer: expected.issuer,
      audience: expected.clientId,
      algorithms: ALGORITHMS,
      maxTokenAge: MAX_TOKEN_AGE_S,
      clockTolerance: 30,
      requiredClaims: ["iat", "jti", "events"],
    }));
  } catch (error) {
    throw new AppError("invalid_credentials", { cause: error });
  }
  const { events, nonce, jti, sub, sid } = payload;
  const isLogout =
    typeof events === "object" &&
    events !== null &&
    typeof (events as Record<string, unknown>)[LOGOUT_EVENT] === "object";
  const subject = typeof sub === "string" && sub ? sub : undefined;
  const session = typeof sid === "string" && sid ? sid : undefined;
  if (
    !isLogout ||
    nonce !== undefined ||
    typeof jti !== "string" ||
    (!subject && !session)
  ) {
    throw new AppError("invalid_credentials");
  }
  return {
    jti,
    ...(subject ? { subject } : {}),
    ...(session ? { sid: session } : {}),
  };
}

/** A logout token counts once: the same one sent again is refused. */
export async function spendLogoutToken(
  db: Database,
  key: KeyRing,
  issuer: string,
  jti: string,
): Promise<void> {
  const sealed = encryptSecret("seen", key, "sso-state");
  try {
    await db
      .insertInto("oauthStates")
      .values({
        stateHash: hashSessionToken(`oidc-logout:${issuer}:${jti}`),
        kind: "oidc-logout",
        verifierCiphertext: sealed.ciphertext,
        verifierNonce: sealed.nonce,
        expiresAt: new Date(Date.now() + SPENT_FOR_MS),
      })
      .execute();
  } catch (error) {
    if (isUniqueViolation(error)) throw new AppError("invalid_credentials");
    throw error;
  }
}

/**
 * Ends what the provider's logout names: its one session when it gives
 * one, else every session it opened for the subject, with any sign-in of
 * theirs still waiting for a second step. Returns the sessions' hashes.
 */
export async function endProviderSessions(
  db: Database,
  input: { issuer: string; subject?: string; sid?: string },
): Promise<string[]> {
  return db.transaction().execute(async (tx) => {
    const account = input.subject
      ? await tx
          .selectFrom("ssoIdentities")
          .select("userId")
          .where("provider", "=", "oidc")
          .where("issuer", "=", input.issuer)
          .where("subject", "=", input.subject)
          .executeTakeFirst()
      : undefined;
    if (input.subject) {
      // A first sign-in waiting for its factor has no binding yet.
      await tx
        .deleteFrom("loginChallenges")
        .where("signOn", "=", "oidc")
        .where("bindIssuer", "=", input.issuer)
        .where("bindSubject", "=", input.subject)
        .execute();
    }
    if (input.subject && !account) return [];
    const sidHash = input.sid
      ? hashProviderSession(input.issuer, input.sid)
      : undefined;
    const ended = await tx
      .deleteFrom("sessions")
      .where("signOn", "=", "oidc")
      .$if(sidHash !== undefined, (query) =>
        query.where("signOnSid", "=", sidHash ?? ""),
      )
      .$if(account !== undefined, (query) =>
        query.where("userId", "=", account?.userId ?? ""),
      )
      .returning(["tokenHash", "userId"])
      .execute();
    await tx
      .deleteFrom("loginChallenges")
      .where("signOn", "=", "oidc")
      .$if(sidHash !== undefined, (query) =>
        query.where("signOnSid", "=", sidHash ?? ""),
      )
      .$if(account !== undefined, (query) =>
        query.where("userId", "=", account?.userId ?? ""),
      )
      .execute();
    for (const userId of new Set(ended.map((row) => row.userId))) {
      await recordAuthEvent(tx, {
        action: "session_revoked",
        userId,
        method: "oidc",
        detail: "provider_logout",
      });
    }
    return ended.map((row) => row.tokenHash);
  });
}
