/**
 * Authorization code + PKCE + refresh for applications (ADR 0094).
 * Access tokens are normal api_tokens rows so REST and MCP stay one path.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { AppError, roleAllows, roleFor } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { sql } from "kysely";
import { loadBindings } from "../auth/access.js";
import { createApiToken, tokenDays } from "../auth/tokens.js";
import { readGateSettings } from "../settings.js";
import { findLiveOauthClient } from "./clients.js";
import { sha256Hex } from "./hash.js";
import { isCodeChallenge, verifyPkce } from "./pkce.js";

const CODE_TTL_MS = 10 * 60_000;
const REFRESH_DAYS = 90;

export type ConsentInput = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  baseIds: readonly string[];
  readOnly?: boolean;
  allowDelete?: boolean;
};

/** Issues a one-time authorization code after the person consents. */
export async function issueAuthorizationCode(
  db: Database,
  userId: string,
  input: ConsentInput,
): Promise<{ code: string; redirectUri: string }> {
  if (!isCodeChallenge(input.codeChallenge)) {
    throw new AppError("invalid_input");
  }
  const client = await findLiveOauthClient(db, input.clientId);
  if (!client) throw new AppError("invalid_input");
  if (!client.redirectUris.includes(input.redirectUri)) {
    throw new AppError("invalid_input");
  }
  const baseIds = [...new Set(input.baseIds)];
  if (baseIds.length === 0) throw new AppError("invalid_input");
  const bindings = await loadBindings(db, userId);
  for (const baseId of baseIds) {
    if (!roleAllows(roleFor(bindings, "base", baseId), "read")) {
      throw new AppError("access_denied");
    }
  }

  const code = `ago_${randomBytes(32).toString("base64url")}`;
  await db
    .insertInto("oauthAuthorizationCodes")
    .values({
      codeHash: sha256Hex(code),
      clientId: client.id,
      userId,
      redirectUri: input.redirectUri,
      codeChallenge: input.codeChallenge,
      codeChallengeMethod: "S256",
      baseIds: sql<string[]>`array[${sql.join(
        baseIds.map((id) => sql`${id}::uuid`),
      )}]::uuid[]`,
      readOnly: input.readOnly === true,
      allowDelete: input.readOnly === true ? true : input.allowDelete !== false,
      expiresAt: new Date(Date.now() + CODE_TTL_MS),
    })
    .execute();
  return { code, redirectUri: input.redirectUri };
}

function secretsEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export type TokenResponse = {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
};

/** Exchanges a code for an access token and a refresh token. */
export async function exchangeAuthorizationCode(
  db: Database,
  input: {
    clientId: string;
    clientSecret: string;
    code: string;
    redirectUri: string;
    codeVerifier: string;
  },
): Promise<TokenResponse> {
  const client = await findLiveOauthClient(db, input.clientId);
  if (
    !client ||
    !secretsEqual(client.secretHash, sha256Hex(input.clientSecret))
  ) {
    throw new AppError("invalid_input");
  }

  const row = await db
    .selectFrom("oauthAuthorizationCodes")
    .selectAll()
    .where("codeHash", "=", sha256Hex(input.code))
    .where("clientId", "=", client.id)
    .executeTakeFirst();
  if (
    !row ||
    row.usedAt ||
    row.expiresAt.getTime() <= Date.now() ||
    row.redirectUri !== input.redirectUri ||
    !verifyPkce(input.codeVerifier, row.codeChallenge)
  ) {
    throw new AppError("invalid_input");
  }

  const claimed = await db
    .updateTable("oauthAuthorizationCodes")
    .set({ usedAt: new Date() })
    .where("id", "=", row.id)
    .where("usedAt", "is", null)
    .returning("id")
    .executeTakeFirst();
  if (!claimed) throw new AppError("invalid_input");

  const policy = await readGateSettings(db);
  const days = tokenDays(undefined, policy);
  const access = await createApiToken(db, row.userId, `OAuth: ${client.name}`, {
    baseIds: row.baseIds,
    readOnly: row.readOnly,
    allowDelete: row.allowDelete,
    days,
    oauthClientId: client.id,
    detail: "oauth_grant",
  });

  const refresh = `agr_${randomBytes(32).toString("base64url")}`;
  await db
    .insertInto("oauthRefreshTokens")
    .values({
      tokenHash: sha256Hex(refresh),
      clientId: client.id,
      userId: row.userId,
      apiTokenId: access.id,
      expiresAt: new Date(Date.now() + REFRESH_DAYS * 86_400_000),
    })
    .execute();

  return {
    access_token: access.token,
    token_type: "Bearer",
    expires_in: days * 86_400,
    refresh_token: refresh,
  };
}

/** Rotates the refresh token and mints a new access token for the same grant. */
export async function refreshAccessToken(
  db: Database,
  input: {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
  },
): Promise<TokenResponse> {
  const client = await findLiveOauthClient(db, input.clientId);
  if (
    !client ||
    !secretsEqual(client.secretHash, sha256Hex(input.clientSecret))
  ) {
    throw new AppError("invalid_input");
  }

  const refresh = await db
    .selectFrom("oauthRefreshTokens as r")
    .innerJoin("apiTokens as t", "t.id", "r.apiTokenId")
    .select([
      "r.id",
      "r.userId",
      "r.expiresAt",
      "r.revokedAt",
      "t.baseIds",
      "t.readOnly",
      "t.allowDelete",
      "t.id as apiTokenId",
    ])
    .where("r.tokenHash", "=", sha256Hex(input.refreshToken))
    .where("r.clientId", "=", client.id)
    .executeTakeFirst();
  if (
    !refresh ||
    refresh.revokedAt ||
    refresh.expiresAt.getTime() <= Date.now()
  ) {
    throw new AppError("invalid_input");
  }

  await db
    .updateTable("oauthRefreshTokens")
    .set({ revokedAt: new Date() })
    .where("id", "=", refresh.id)
    .execute();
  await db
    .deleteFrom("apiTokens")
    .where("id", "=", refresh.apiTokenId)
    .execute();

  const policy = await readGateSettings(db);
  const days = tokenDays(undefined, policy);
  const baseIds = Array.isArray(refresh.baseIds) ? refresh.baseIds : undefined;
  const access = await createApiToken(
    db,
    refresh.userId,
    `OAuth: ${client.name}`,
    {
      baseIds,
      readOnly: refresh.readOnly,
      allowDelete: refresh.allowDelete,
      days,
      oauthClientId: client.id,
      detail: "oauth_refresh",
    },
  );

  const next = `agr_${randomBytes(32).toString("base64url")}`;
  await db
    .insertInto("oauthRefreshTokens")
    .values({
      tokenHash: sha256Hex(next),
      clientId: client.id,
      userId: refresh.userId,
      apiTokenId: access.id,
      expiresAt: new Date(Date.now() + REFRESH_DAYS * 86_400_000),
    })
    .execute();

  return {
    access_token: access.token,
    token_type: "Bearer",
    expires_in: days * 86_400,
    refresh_token: next,
  };
}

/** Revokes a refresh token and its access token. */
export async function revokeRefreshToken(
  db: Database,
  input: {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
  },
): Promise<void> {
  const client = await findLiveOauthClient(db, input.clientId);
  if (
    !client ||
    !secretsEqual(client.secretHash, sha256Hex(input.clientSecret))
  ) {
    throw new AppError("invalid_input");
  }
  const refresh = await db
    .selectFrom("oauthRefreshTokens")
    .select(["id", "apiTokenId", "revokedAt"])
    .where("tokenHash", "=", sha256Hex(input.refreshToken))
    .where("clientId", "=", client.id)
    .executeTakeFirst();
  if (!refresh) return;
  if (!refresh.revokedAt) {
    await db
      .updateTable("oauthRefreshTokens")
      .set({ revokedAt: new Date() })
      .where("id", "=", refresh.id)
      .execute();
  }
  await db
    .deleteFrom("apiTokens")
    .where("id", "=", refresh.apiTokenId)
    .execute();
}
