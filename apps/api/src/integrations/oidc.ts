/**
 * Operator OIDC stored in the database (ADR 0050). The client secret is
 * sealed; the redirect URL is derived from PUBLIC_URL.
 */
import { AppError } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { z } from "zod";
import { decryptSecret, encryptSecret } from "../auth/crypto.js";
import { recordAuthEvent } from "../auth/auth-events.js";

const CACHE_TTL_MS = 5_000;

const oidcCache = new WeakMap<
  Database,
  { at: number; value: Promise<OidcRow | null> }
>();

export type OidcRow = {
  issuer: string;
  clientId: string;
  clientSecretCiphertext: Buffer;
  clientSecretNonce: Buffer;
  updatedAt: Date;
  updatedBy: string | null;
};

export type PublicOidc = {
  configured: boolean;
  issuer: string | null;
  clientId: string | null;
  hasClientSecret: boolean;
  redirectUrl: string | null;
  updatedAt: string | null;
};

export type OidcConfig = {
  OIDC_ISSUER: string;
  OIDC_CLIENT_ID: string;
  OIDC_CLIENT_SECRET: string;
  OIDC_REDIRECT_URL: string;
};

export type OidcSource = "database" | "env" | "none";

export const oidcUpdateSchema = z
  .object({
    issuer: z.url().max(2048),
    clientId: z.string().trim().min(1).max(512),
    /** Omitted keeps the stored secret. Required on first save. */
    clientSecret: z.string().min(1).max(2048).optional(),
  })
  .strict();

export type OidcUpdate = z.infer<typeof oidcUpdateSchema>;

export function clearOidcCache(db: Database): void {
  oidcCache.delete(db);
}

export function loadOidcRow(db: Database): Promise<OidcRow | null> {
  const now = Date.now();
  const cached = oidcCache.get(db);
  if (cached && now - cached.at <= CACHE_TTL_MS) return cached.value;
  const value = db
    .selectFrom("instanceOidc")
    .selectAll()
    .where("id", "=", true)
    .executeTakeFirst()
    .then((row) => row ?? null);
  oidcCache.set(db, { at: now, value });
  value.catch(() => {
    if (oidcCache.get(db)?.value === value) oidcCache.delete(db);
  });
  return value;
}

export function oidcRedirectUrl(publicUrl: string): string {
  return `${publicUrl.replace(/\/+$/, "")}/auth/oidc/callback`;
}

export function publicOidc(row: OidcRow | null, publicUrl: string): PublicOidc {
  if (!row) {
    return {
      configured: false,
      issuer: null,
      clientId: null,
      hasClientSecret: false,
      redirectUrl: null,
      updatedAt: null,
    };
  }
  return {
    configured: true,
    issuer: row.issuer,
    clientId: row.clientId,
    hasClientSecret: true,
    redirectUrl: oidcRedirectUrl(publicUrl),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function envOidc(env: {
  OIDC_ISSUER?: string;
  OIDC_CLIENT_ID?: string;
  OIDC_CLIENT_SECRET?: string;
  OIDC_REDIRECT_URL?: string;
}): OidcConfig | null {
  if (
    !env.OIDC_ISSUER ||
    !env.OIDC_CLIENT_ID ||
    !env.OIDC_CLIENT_SECRET ||
    !env.OIDC_REDIRECT_URL
  ) {
    return null;
  }
  return {
    OIDC_ISSUER: env.OIDC_ISSUER,
    OIDC_CLIENT_ID: env.OIDC_CLIENT_ID,
    OIDC_CLIENT_SECRET: env.OIDC_CLIENT_SECRET,
    OIDC_REDIRECT_URL: env.OIDC_REDIRECT_URL,
  };
}

export async function resolveOidc(
  db: Database,
  env: {
    AUTH_ENCRYPTION_KEY: Buffer;
    PUBLIC_URL: string;
    OIDC_ISSUER?: string;
    OIDC_CLIENT_ID?: string;
    OIDC_CLIENT_SECRET?: string;
    OIDC_REDIRECT_URL?: string;
  },
): Promise<{ config: OidcConfig | null; source: OidcSource }> {
  const row = await loadOidcRow(db);
  if (row) {
    return {
      config: {
        OIDC_ISSUER: row.issuer,
        OIDC_CLIENT_ID: row.clientId,
        OIDC_CLIENT_SECRET: decryptSecret(
          row.clientSecretCiphertext,
          row.clientSecretNonce,
          env.AUTH_ENCRYPTION_KEY,
        ),
        OIDC_REDIRECT_URL: oidcRedirectUrl(env.PUBLIC_URL),
      },
      source: "database",
    };
  }
  const config = envOidc(env);
  return { config, source: config ? "env" : "none" };
}

export async function saveOidc(
  db: Database,
  key: Buffer,
  userId: string,
  input: OidcUpdate,
  publicUrl: string,
  options: { ip?: string } = {},
): Promise<PublicOidc> {
  const existing = await db
    .selectFrom("instanceOidc")
    .selectAll()
    .where("id", "=", true)
    .executeTakeFirst();

  // openid-client reaches a provider over HTTPS only: say so at the save.
  if (!input.issuer.startsWith("https://")) {
    throw new AppError("invalid_oidc");
  }

  let ciphertext = existing?.clientSecretCiphertext;
  let nonce = existing?.clientSecretNonce;
  if (input.clientSecret !== undefined) {
    const sealed = encryptSecret(input.clientSecret, key);
    ciphertext = sealed.ciphertext;
    nonce = sealed.nonce;
  }
  if (!ciphertext || !nonce) {
    throw new AppError("invalid_oidc");
  }

  const row = {
    id: true as const,
    issuer: input.issuer,
    clientId: input.clientId,
    clientSecretCiphertext: ciphertext,
    clientSecretNonce: nonce,
    updatedBy: userId,
    updatedAt: new Date(),
  };

  const saved = await db
    .insertInto("instanceOidc")
    .values(row)
    .onConflict((conflict) =>
      conflict.column("id").doUpdateSet({
        issuer: row.issuer,
        clientId: row.clientId,
        clientSecretCiphertext: row.clientSecretCiphertext,
        clientSecretNonce: row.clientSecretNonce,
        updatedBy: row.updatedBy,
        updatedAt: row.updatedAt,
      }),
    )
    .returningAll()
    .executeTakeFirstOrThrow();

  clearOidcCache(db);
  await recordAuthEvent(db, {
    action: "settings_changed",
    actorId: userId,
    method: "admin",
    detail: "oidc",
    ip: options.ip,
  });
  return publicOidc(saved, publicUrl);
}

export async function clearOidc(
  db: Database,
  userId: string,
  ip?: string,
): Promise<void> {
  await db.deleteFrom("instanceOidc").where("id", "=", true).execute();
  clearOidcCache(db);
  await recordAuthEvent(db, {
    action: "settings_changed",
    actorId: userId,
    method: "admin",
    detail: "oidc",
    ip,
  });
}
