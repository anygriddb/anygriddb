/**
 * Operator SMTP stored in the database (ADR 0050). The password is sealed
 * with AUTH_ENCRYPTION_KEY and never returned to the client.
 */
import type { KeyRing } from "../auth/key-ring.js";
import type { Database } from "@anygriddb/db";
import { z } from "zod";
import { decryptSecret, encryptSecret } from "../auth/crypto.js";
import { recordAuthEvent } from "../auth/auth-events.js";
import type { SmtpConfig } from "../mail.js";
import { smtpReady, verifySmtp } from "../mail.js";

const CACHE_TTL_MS = 5_000;

const smtpCache = new WeakMap<
  Database,
  { at: number; value: Promise<SmtpRow | null> }
>();

export type SmtpRow = {
  host: string;
  port: number;
  username: string | null;
  fromAddress: string;
  passwordCiphertext: Buffer | null;
  passwordNonce: Buffer | null;
  updatedAt: Date;
  updatedBy: string | null;
};

export type PublicSmtp = {
  configured: boolean;
  host: string | null;
  port: number | null;
  username: string | null;
  fromAddress: string | null;
  hasPassword: boolean;
  updatedAt: string | null;
};

export type SmtpSource = "database" | "env" | "none";

export const smtpUpdateSchema = z
  .object({
    host: z.string().trim().min(1).max(253),
    port: z.int().min(1).max(65535).default(587),
    username: z.string().trim().min(1).max(320).nullable().optional(),
    fromAddress: z.string().trim().min(3).max(320),
    /** Omitted keeps the stored password; null clears it. */
    password: z.string().min(1).max(512).nullable().optional(),
  })
  .strict();

export type SmtpUpdate = z.infer<typeof smtpUpdateSchema>;

export function clearSmtpCache(db: Database): void {
  smtpCache.delete(db);
}

export function loadSmtpRow(db: Database): Promise<SmtpRow | null> {
  const now = Date.now();
  const cached = smtpCache.get(db);
  if (cached && now - cached.at <= CACHE_TTL_MS) return cached.value;
  const value = db
    .selectFrom("instanceSmtp")
    .selectAll()
    .where("id", "=", true)
    .executeTakeFirst()
    .then((row) => row ?? null);
  smtpCache.set(db, { at: now, value });
  value.catch(() => {
    if (smtpCache.get(db)?.value === value) smtpCache.delete(db);
  });
  return value;
}

export function publicSmtp(row: SmtpRow | null): PublicSmtp {
  if (!row) {
    return {
      configured: false,
      host: null,
      port: null,
      username: null,
      fromAddress: null,
      hasPassword: false,
      updatedAt: null,
    };
  }
  return {
    configured: true,
    host: row.host,
    port: row.port,
    username: row.username,
    fromAddress: row.fromAddress,
    hasPassword: Boolean(row.passwordCiphertext && row.passwordNonce),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function envSmtp(env: SmtpConfig): SmtpConfig {
  return {
    SMTP_HOST: env.SMTP_HOST,
    SMTP_PORT: env.SMTP_PORT,
    SMTP_USER: env.SMTP_USER,
    SMTP_PASSWORD: env.SMTP_PASSWORD,
    SMTP_FROM: env.SMTP_FROM,
  };
}

function rowToConfig(row: SmtpRow, key: KeyRing): SmtpConfig {
  const password =
    row.passwordCiphertext && row.passwordNonce
      ? decryptSecret(row.passwordCiphertext, row.passwordNonce, key, "smtp")
      : undefined;
  return {
    SMTP_HOST: row.host,
    SMTP_PORT: row.port,
    SMTP_USER: row.username ?? undefined,
    SMTP_PASSWORD: password,
    SMTP_FROM: row.fromAddress,
  };
}

/**
 * The saved row when there is one; otherwise the environment. Returns
 * which side supplied the config for the admin UI.
 */
export async function resolveSmtp(
  db: Database,
  env: SmtpConfig & { AUTH_ENCRYPTION_KEY: KeyRing },
): Promise<{ config: SmtpConfig; source: SmtpSource }> {
  const row = await loadSmtpRow(db);
  if (row) {
    return {
      config: rowToConfig(row, env.AUTH_ENCRYPTION_KEY),
      source: "database",
    };
  }
  const config = envSmtp(env);
  return {
    config,
    source: smtpReady(config) ? "env" : "none",
  };
}

export async function saveSmtp(
  db: Database,
  key: KeyRing,
  userId: string,
  input: SmtpUpdate,
  options: { ip?: string } = {},
): Promise<PublicSmtp> {
  const existing = await db
    .selectFrom("instanceSmtp")
    .selectAll()
    .where("id", "=", true)
    .executeTakeFirst();

  const username =
    input.username === undefined
      ? (existing?.username ?? null)
      : input.username;

  // A relay without a username takes no password: the one stored goes.
  let passwordCiphertext: Buffer | null = existing?.passwordCiphertext ?? null;
  let passwordNonce: Buffer | null = existing?.passwordNonce ?? null;
  if (input.password === null || username === null) {
    passwordCiphertext = null;
    passwordNonce = null;
  } else if (input.password !== undefined) {
    const sealed = encryptSecret(input.password, key, "smtp");
    passwordCiphertext = sealed.ciphertext;
    passwordNonce = sealed.nonce;
  }

  const config: SmtpConfig = {
    SMTP_HOST: input.host,
    SMTP_PORT: input.port,
    SMTP_USER: username ?? undefined,
    SMTP_PASSWORD:
      passwordCiphertext && passwordNonce
        ? decryptSecret(passwordCiphertext, passwordNonce, key, "smtp")
        : undefined,
    SMTP_FROM: input.fromAddress,
  };

  // Nothing is saved that the relay refuses.
  await verifySmtp(config);

  const row = {
    id: true as const,
    host: input.host,
    port: input.port,
    username,
    fromAddress: input.fromAddress,
    passwordCiphertext,
    passwordNonce,
    updatedBy: userId,
    updatedAt: new Date(),
  };

  const saved = await db
    .insertInto("instanceSmtp")
    .values(row)
    .onConflict((conflict) =>
      conflict.column("id").doUpdateSet({
        host: row.host,
        port: row.port,
        username: row.username,
        fromAddress: row.fromAddress,
        passwordCiphertext: row.passwordCiphertext,
        passwordNonce: row.passwordNonce,
        updatedBy: row.updatedBy,
        updatedAt: row.updatedAt,
      }),
    )
    .returningAll()
    .executeTakeFirstOrThrow();

  clearSmtpCache(db);
  await recordAuthEvent(db, {
    action: "settings_changed",
    actorId: userId,
    method: "admin",
    detail: "smtp",
    ip: options.ip,
  });
  return publicSmtp(saved);
}

export async function clearSmtp(
  db: Database,
  userId: string,
  ip?: string,
): Promise<void> {
  await db.deleteFrom("instanceSmtp").where("id", "=", true).execute();
  clearSmtpCache(db);
  await recordAuthEvent(db, {
    action: "settings_changed",
    actorId: userId,
    method: "admin",
    detail: "smtp",
    ip,
  });
}
