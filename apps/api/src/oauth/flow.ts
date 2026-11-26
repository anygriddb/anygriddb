/**
 * Authorization code + PKCE + refresh for applications (ADR 0094).
 * Access tokens are normal api_tokens rows so REST and MCP stay one path.
 */
import { randomBytes } from "node:crypto";
import { AppError, roleFor, ceilingOf } from "@anygriddb/core";
import { granted } from "../access/declaration.js";
import type { Database, Tx } from "@anygriddb/db";
import { sql } from "kysely";
import { loadBindings } from "../auth/access.js";
import { verifyPassword } from "../auth/argon2.js";
import { hashApiToken, insertApiToken, tokenDays } from "../auth/tokens.js";
import { readGateSettings } from "../settings.js";
import { findLiveOauthClient } from "./clients.js";
import { sha256Hex } from "./hash.js";
import { isCodeChallenge, verifyPkce } from "./pkce.js";

const CODE_TTL_MS = ceilingOf("protocol.oauth_code_ms");
const REFRESH_DAYS = ceilingOf("protocol.oauth_refresh_days");

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
  // An application holds a token: it is given only bases whose role lets
  // a token in.
  for (const baseId of baseIds) {
    const role = roleFor(bindings, "base", baseId);
    if (!granted(role, "rows.read") || !granted(role, "api.access")) {
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

type OauthClient = NonNullable<Awaited<ReturnType<typeof findLiveOauthClient>>>;

/** What a refusal says when it is the client that did not prove itself. */
export const CLIENT_REFUSED = "client";

/**
 * The live client these credentials name. A refusal names the client, so
 * that the token address answers `invalid_client` rather than
 * `invalid_grant`.
 */
async function authenticClient(
  db: Database,
  input: { clientId: string; clientSecret: string },
): Promise<OauthClient> {
  const client = await findLiveOauthClient(db, input.clientId);
  if (
    !client ||
    !(await verifyPassword(client.secretHash, input.clientSecret))
  ) {
    throw new AppError("invalid_input", CLIENT_REFUSED);
  }
  return client;
}

export type TokenResponse = {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
};

/**
 * An access token and the refresh token that renews it, in the caller's
 * transaction: with what they replace, or not at all.
 */
async function issueTokens(
  tx: Tx,
  client: OauthClient,
  grant: {
    userId: string;
    baseIds: string[] | null;
    readOnly: boolean;
    allowDelete: boolean;
  },
  made: { days: number; detail: "oauth_grant" | "oauth_refresh" },
): Promise<TokenResponse> {
  const { days } = made;
  const access = await insertApiToken(
    tx,
    grant.userId,
    `OAuth: ${client.name}`,
    {
      baseIds: grant.baseIds ?? undefined,
      readOnly: grant.readOnly,
      allowDelete: grant.allowDelete,
      days,
      oauthClientId: client.id,
      detail: made.detail,
    },
  );
  const refresh = `agr_${randomBytes(32).toString("base64url")}`;
  await tx
    .insertInto("oauthRefreshTokens")
    .values({
      tokenHash: sha256Hex(refresh),
      clientId: client.id,
      userId: grant.userId,
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
  const client = await authenticClient(db, input);
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
  const days = tokenDays(undefined, await readGateSettings(db));
  // The code is taken and its tokens made together: of two exchanges sent
  // at once one takes it, and a failure leaves it to be tried again.
  return db.transaction().execute(async (tx) => {
    const taken = await tx
      .updateTable("oauthAuthorizationCodes")
      .set({ usedAt: new Date() })
      .where("id", "=", row.id)
      .where("usedAt", "is", null)
      .returning("id")
      .executeTakeFirst();
    if (!taken) throw new AppError("invalid_input");
    return issueTokens(tx, client, row, { days, detail: "oauth_grant" });
  });
}

/**
 * Renews a grant: the refresh token and its access token are replaced by
 * new ones, in one transaction. Of two renewals sent at once with one
 * refresh token, one takes it and the other is refused.
 */
export async function refreshAccessToken(
  db: Database,
  input: {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
  },
): Promise<TokenResponse> {
  const client = await authenticClient(db, input);
  const days = tokenDays(undefined, await readGateSettings(db));
  return db.transaction().execute(async (tx) => {
    const taken = await tx
      .updateTable("oauthRefreshTokens")
      .set({ revokedAt: new Date() })
      .where("tokenHash", "=", sha256Hex(input.refreshToken))
      .where("clientId", "=", client.id)
      .where("revokedAt", "is", null)
      .where("expiresAt", ">", new Date())
      .returning(["userId", "apiTokenId"])
      .executeTakeFirst();
    if (!taken) throw new AppError("invalid_input");
    // The access token goes, and takes the refresh token just used with it.
    const replaced = await tx
      .deleteFrom("apiTokens")
      .where("id", "=", taken.apiTokenId)
      .returning(["baseIds", "readOnly", "allowDelete"])
      .executeTakeFirst();
    if (!replaced) throw new AppError("invalid_input");
    return issueTokens(
      tx,
      client,
      {
        userId: taken.userId,
        baseIds: Array.isArray(replaced.baseIds) ? replaced.baseIds : null,
        readOnly: replaced.readOnly,
        allowDelete: replaced.allowDelete,
      },
      { days, detail: "oauth_refresh" },
    );
  });
}

/**
 * Ends a grant of this client from either of its tokens (RFC 7009): a
 * client may hold only its access token when it signs someone out.
 */
export async function revokeGrantToken(
  db: Database,
  input: {
    clientId: string;
    clientSecret: string;
    token: string;
  },
): Promise<void> {
  const client = await authenticClient(db, input);
  // Deleting the access token removes the refresh token with it.
  await db
    .deleteFrom("apiTokens")
    .where("oauthClientId", "=", client.id)
    .where((eb) =>
      eb.or([
        eb("tokenHash", "=", hashApiToken(input.token)),
        eb("id", "in", (inner) =>
          inner
            .selectFrom("oauthRefreshTokens")
            .select("apiTokenId")
            .where("tokenHash", "=", sha256Hex(input.token))
            .where("clientId", "=", client.id),
        ),
      ]),
    )
    .execute();
}

/**
 * Codes that were used or ran out, and refresh tokens past their time:
 * each is refused wherever it is read, and the hourly purge deletes the
 * rows, so that a table of secrets' hashes does not grow with every grant.
 */
export async function purgeOauthGrants(db: Database): Promise<void> {
  const now = new Date();
  await db
    .deleteFrom("oauthAuthorizationCodes")
    .where((eb) =>
      eb.or([eb("expiresAt", "<", now), eb("usedAt", "is not", null)]),
    )
    .execute();
  await db
    .deleteFrom("oauthRefreshTokens")
    .where("expiresAt", "<", now)
    .execute();
}
