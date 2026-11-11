/**
 * Operator SAML stored in the database (ADR 0050). The ACS URL is derived
 * from PUBLIC_URL; the IdP certificate is PEM text (not a sealed secret).
 */
import { AppError } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { z } from "zod";
import { recordAuthEvent } from "../auth/auth-events.js";

const CACHE_TTL_MS = 5_000;

const samlCache = new WeakMap<
  Database,
  { at: number; value: Promise<SamlRow | null> }
>();

export type SamlRow = {
  entryPoint: string;
  issuer: string;
  idpCert: string;
  updatedAt: Date;
  updatedBy: string | null;
};

export type PublicSaml = {
  configured: boolean;
  entryPoint: string | null;
  issuer: string | null;
  hasIdpCert: boolean;
  callbackUrl: string | null;
  updatedAt: string | null;
};

export type SamlConfig = {
  SAML_ENTRY_POINT: string;
  SAML_ISSUER: string;
  SAML_CERT: string;
  SAML_CALLBACK_URL: string;
};

export type SamlSource = "database" | "env" | "none";

export const samlUpdateSchema = z
  .object({
    entryPoint: z.url().max(2048),
    issuer: z.string().trim().min(1).max(1024),
    /** Omitted keeps the stored certificate. Required on first save. */
    idpCert: z.string().trim().min(1).max(16384).optional(),
  })
  .strict();

export type SamlUpdate = z.infer<typeof samlUpdateSchema>;

export function clearSamlCache(db: Database): void {
  samlCache.delete(db);
}

export function loadSamlRow(db: Database): Promise<SamlRow | null> {
  const now = Date.now();
  const cached = samlCache.get(db);
  if (cached && now - cached.at <= CACHE_TTL_MS) return cached.value;
  const value = db
    .selectFrom("instanceSaml")
    .selectAll()
    .where("id", "=", true)
    .executeTakeFirst()
    .then((row) => row ?? null);
  samlCache.set(db, { at: now, value });
  value.catch(() => {
    if (samlCache.get(db)?.value === value) samlCache.delete(db);
  });
  return value;
}

export function samlCallbackUrl(publicUrl: string): string {
  return `${publicUrl.replace(/\/+$/, "")}/auth/saml/acs`;
}

export function publicSaml(row: SamlRow | null, publicUrl: string): PublicSaml {
  if (!row) {
    return {
      configured: false,
      entryPoint: null,
      issuer: null,
      hasIdpCert: false,
      callbackUrl: null,
      updatedAt: null,
    };
  }
  return {
    configured: true,
    entryPoint: row.entryPoint,
    issuer: row.issuer,
    hasIdpCert: true,
    callbackUrl: samlCallbackUrl(publicUrl),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function envSaml(env: {
  SAML_ENTRY_POINT?: string;
  SAML_ISSUER?: string;
  SAML_CERT?: string;
  SAML_CALLBACK_URL?: string;
}): SamlConfig | null {
  if (
    !env.SAML_ENTRY_POINT ||
    !env.SAML_ISSUER ||
    !env.SAML_CERT ||
    !env.SAML_CALLBACK_URL
  ) {
    return null;
  }
  return {
    SAML_ENTRY_POINT: env.SAML_ENTRY_POINT,
    SAML_ISSUER: env.SAML_ISSUER,
    SAML_CERT: env.SAML_CERT,
    SAML_CALLBACK_URL: env.SAML_CALLBACK_URL,
  };
}

export async function resolveSaml(
  db: Database,
  env: {
    PUBLIC_URL: string;
    SAML_ENTRY_POINT?: string;
    SAML_ISSUER?: string;
    SAML_CERT?: string;
    SAML_CALLBACK_URL?: string;
  },
): Promise<{ config: SamlConfig | null; source: SamlSource }> {
  const row = await loadSamlRow(db);
  if (row) {
    return {
      config: {
        SAML_ENTRY_POINT: row.entryPoint,
        SAML_ISSUER: row.issuer,
        SAML_CERT: row.idpCert,
        SAML_CALLBACK_URL: samlCallbackUrl(env.PUBLIC_URL),
      },
      source: "database",
    };
  }
  const config = envSaml(env);
  return { config, source: config ? "env" : "none" };
}

export async function saveSaml(
  db: Database,
  userId: string,
  input: SamlUpdate,
  publicUrl: string,
  options: { ip?: string } = {},
): Promise<PublicSaml> {
  if (!input.entryPoint.startsWith("https://")) {
    throw new AppError("invalid_saml");
  }

  const existing = await db
    .selectFrom("instanceSaml")
    .selectAll()
    .where("id", "=", true)
    .executeTakeFirst();
  const idpCert = input.idpCert ?? existing?.idpCert;
  if (!idpCert) throw new AppError("invalid_saml");

  const row = {
    id: true as const,
    entryPoint: input.entryPoint,
    issuer: input.issuer,
    idpCert,
    updatedBy: userId,
    updatedAt: new Date(),
  };

  const saved = await db
    .insertInto("instanceSaml")
    .values(row)
    .onConflict((conflict) =>
      conflict.column("id").doUpdateSet({
        entryPoint: row.entryPoint,
        issuer: row.issuer,
        idpCert: row.idpCert,
        updatedBy: row.updatedBy,
        updatedAt: row.updatedAt,
      }),
    )
    .returningAll()
    .executeTakeFirstOrThrow();

  clearSamlCache(db);
  await recordAuthEvent(db, {
    action: "settings_changed",
    actorId: userId,
    method: "admin",
    detail: "saml",
    ip: options.ip,
  });
  return publicSaml(saved, publicUrl);
}

export async function clearSaml(
  db: Database,
  userId: string,
  ip?: string,
): Promise<void> {
  await db.deleteFrom("instanceSaml").where("id", "=", true).execute();
  clearSamlCache(db);
  await recordAuthEvent(db, {
    action: "settings_changed",
    actorId: userId,
    method: "admin",
    detail: "saml",
    ip,
  });
}
