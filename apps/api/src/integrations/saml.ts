/**
 * Operator SAML stored in the database (ADR 0050). The ACS URL is derived
 * from PUBLIC_URL; the IdP certificate is PEM text (not a sealed secret).
 */
import { X509Certificate } from "node:crypto";
import { AppError } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { z } from "zod";
import { recordAuthEvent } from "../auth/auth-events.js";
import {
  assertProviderRemains,
  type ProviderEnvironment,
} from "../auth/sso-only.js";

const PEM_BEGIN = "-----BEGIN CERTIFICATE-----";
const PEM_END = "-----END CERTIFICATE-----";

/**
 * The certificates a field holds, one per PEM block: during a rotation it
 * holds the old one and the new one, and either signature is good. A value
 * without a block (an environment may give bare base64) is kept for the
 * library to read.
 */
export function samlCertificates(text: string): string[] {
  const blocks: string[] = [];
  let from = text.indexOf(PEM_BEGIN);
  while (from !== -1) {
    const end = text.indexOf(PEM_END, from);
    if (end === -1) break;
    const stop = end + PEM_END.length;
    blocks.push(text.slice(from, stop));
    from = text.indexOf(PEM_BEGIN, stop);
  }
  return blocks.length > 0 ? blocks : [text.trim()];
}

/**
 * Parses each IdP signing certificate of the field and refuses the field if
 * one is unreadable or expired, or if a block is cut or of another kind
 * (ADR 0053). A not-yet-valid cert is accepted so an administrator can
 * stage a rotation before its notBefore.
 */
export function proveSamlCertificate(pem: string): void {
  const certificates = samlCertificates(pem);
  if (pem.split("-----BEGIN ").length - 1 > certificates.length) {
    throw new AppError("invalid_saml");
  }
  const now = Date.now();
  for (const certificate of certificates) {
    let cert: X509Certificate;
    try {
      cert = new X509Certificate(certificate);
    } catch (error) {
      throw new AppError("invalid_saml", { cause: error });
    }
    const notAfter = Date.parse(cert.validTo);
    if (!Number.isFinite(notAfter) || notAfter <= now) {
      throw new AppError("invalid_saml");
    }
  }
}

const CACHE_TTL_MS = 5_000;

const samlCache = new WeakMap<
  Database,
  { at: number; value: Promise<SamlRow | null> }
>();

type SamlRow = {
  entryPoint: string;
  issuer: string;
  idpCert: string;
  trustsAddresses: boolean;
  updatedAt: Date;
  updatedBy: string | null;
};

type PublicSaml = {
  configured: boolean;
  entryPoint: string | null;
  issuer: string | null;
  hasIdpCert: boolean;
  callbackUrl: string | null;
  /** Whether a first sign-in may reach an existing account by its address. */
  trustsAddresses: boolean;
  updatedAt: string | null;
};

export type SamlConfig = {
  SAML_ENTRY_POINT: string;
  SAML_ISSUER: string;
  SAML_CERT: string;
  SAML_CALLBACK_URL: string;
  SAML_TRUST_ADDRESSES: boolean;
};

type SamlSource = "database" | "env" | "none";

export const samlUpdateSchema = z
  .object({
    entryPoint: z.url().max(2048),
    issuer: z.string().trim().min(1).max(1024),
    /** Omitted keeps the stored certificate. Required on first save. */
    idpCert: z.string().trim().min(1).max(16384).optional(),
    /** Omitted keeps what is stored; off for a new provider (ADR 0111). */
    trustsAddresses: z.boolean().optional(),
  })
  .strict();

type SamlUpdate = z.infer<typeof samlUpdateSchema>;

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
      trustsAddresses: false,
      updatedAt: null,
    };
  }
  return {
    configured: true,
    entryPoint: row.entryPoint,
    issuer: row.issuer,
    hasIdpCert: true,
    callbackUrl: samlCallbackUrl(publicUrl),
    trustsAddresses: row.trustsAddresses,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function envSaml(env: {
  SAML_ENTRY_POINT?: string;
  SAML_ISSUER?: string;
  SAML_CERT?: string;
  SAML_CALLBACK_URL?: string;
  SAML_TRUST_ADDRESSES?: boolean;
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
    SAML_TRUST_ADDRESSES: env.SAML_TRUST_ADDRESSES === true,
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
    SAML_TRUST_ADDRESSES?: boolean;
  },
): Promise<{ config: SamlConfig | null; source: SamlSource }> {
  // The environment first: its operator set it (ADR 0083).
  const fromEnvironment = envSaml(env);
  if (fromEnvironment) return { config: fromEnvironment, source: "env" };
  const row = await loadSamlRow(db);
  if (row) {
    return {
      config: {
        SAML_ENTRY_POINT: row.entryPoint,
        SAML_ISSUER: row.issuer,
        SAML_CERT: row.idpCert,
        SAML_CALLBACK_URL: samlCallbackUrl(env.PUBLIC_URL),
        SAML_TRUST_ADDRESSES: row.trustsAddresses,
      },
      source: "database",
    };
  }
  return { config: null, source: "none" };
}

/**
 * What Administration shows of the provider the environment names.
 * `configured` still says whether a row was saved, which the environment
 * now keeps unused.
 */
export function environmentSaml(
  config: SamlConfig,
  row: SamlRow | null,
): PublicSaml {
  return {
    configured: row !== null,
    entryPoint: config.SAML_ENTRY_POINT,
    issuer: config.SAML_ISSUER,
    hasIdpCert: true,
    callbackUrl: config.SAML_CALLBACK_URL,
    trustsAddresses: config.SAML_TRUST_ADDRESSES,
    updatedAt: null,
  };
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
  proveSamlCertificate(idpCert);

  const row = {
    id: true as const,
    entryPoint: input.entryPoint,
    issuer: input.issuer,
    idpCert,
    trustsAddresses:
      input.trustsAddresses ?? existing?.trustsAddresses ?? false,
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
        trustsAddresses: row.trustsAddresses,
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
  env: ProviderEnvironment,
  userId: string,
  ip?: string,
): Promise<void> {
  await db.transaction().execute(async (tx) => {
    await assertProviderRemains(tx, env, "instanceOidc");
    await tx.deleteFrom("instanceSaml").where("id", "=", true).execute();
  });
  clearSamlCache(db);
  await recordAuthEvent(db, {
    action: "settings_changed",
    actorId: userId,
    method: "admin",
    detail: "saml",
    ip,
  });
}
