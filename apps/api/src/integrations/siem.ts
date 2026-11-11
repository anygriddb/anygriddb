/**
 * Optional SIEM webhook (ADR 0056): posts selected auth_events to an
 * operator HTTPS URL. Secrets stay sealed; payloads never hold emails.
 */
import { AppError } from "@anygriddb/core";
import type { AuthAction, Database } from "@anygriddb/db";
import { z } from "zod";
import { decryptSecret, encryptSecret } from "../auth/crypto.js";
import { recordAuthEvent } from "../auth/auth-events.js";
import { addJob, TASKS } from "../queue/jobs.js";
import { assertPublicHttps, postPinned, signBody } from "../webhooks.js";

const SIEM_ACTIONS = new Set<AuthAction>([
  "login_failure",
  "account_locked",
  "account_unlocked",
  "account_created",
  "account_updated",
  "settings_changed",
  "account_erased",
  "account_disabled",
  "session_revoked",
  "factors_cleared",
  "tokens_revoked",
  "sso_unlinked",
]);
export type SiemRow = {
  url: string;
  secretCiphertext: Buffer;
  secretNonce: Buffer;
  updatedAt: Date;
  updatedBy: string | null;
};

export type PublicSiem = {
  configured: boolean;
  url: string | null;
  hasSecret: boolean;
  updatedAt: string | null;
};

export const siemUpdateSchema = z
  .object({
    url: z.url().max(2048),
    /** Omitted keeps the stored secret. Required on first save. */
    secret: z.string().min(16).max(2048).optional(),
  })
  .strict();

export type SiemUpdate = z.infer<typeof siemUpdateSchema>;

export function publicSiem(row: SiemRow | null): PublicSiem {
  if (!row) {
    return {
      configured: false,
      url: null,
      hasSecret: false,
      updatedAt: null,
    };
  }
  return {
    configured: true,
    url: row.url,
    hasSecret: true,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function loadSiemRow(db: Database): Promise<SiemRow | null> {
  const row = await db
    .selectFrom("instanceSiem")
    .selectAll()
    .where("id", "=", true)
    .executeTakeFirst();
  return row ?? null;
}

export async function saveSiem(
  db: Database,
  key: Buffer,
  userId: string,
  input: SiemUpdate,
  options: { ip?: string } = {},
): Promise<PublicSiem> {
  if (!input.url.startsWith("https://")) {
    throw new AppError("invalid_webhook");
  }
  await assertPublicHttps(input.url);
  const existing = await loadSiemRow(db);
  let ciphertext = existing?.secretCiphertext;
  let nonce = existing?.secretNonce;
  if (input.secret !== undefined) {
    const sealed = encryptSecret(input.secret, key);
    ciphertext = sealed.ciphertext;
    nonce = sealed.nonce;
  }
  if (!ciphertext || !nonce) throw new AppError("invalid_webhook");
  const row = {
    id: true as const,
    url: input.url,
    secretCiphertext: ciphertext,
    secretNonce: nonce,
    updatedBy: userId,
    updatedAt: new Date(),
  };
  const saved = await db
    .insertInto("instanceSiem")
    .values(row)
    .onConflict((conflict) =>
      conflict.column("id").doUpdateSet({
        url: row.url,
        secretCiphertext: row.secretCiphertext,
        secretNonce: row.secretNonce,
        updatedBy: row.updatedBy,
        updatedAt: row.updatedAt,
      }),
    )
    .returningAll()
    .executeTakeFirstOrThrow();
  await recordAuthEvent(db, {
    action: "settings_changed",
    actorId: userId,
    method: "admin",
    detail: "siem",
    ip: options.ip,
  });
  return publicSiem(saved);
}

export async function clearSiem(
  db: Database,
  userId: string,
  ip?: string,
): Promise<void> {
  await db.deleteFrom("instanceSiem").where("id", "=", true).execute();
  await recordAuthEvent(db, {
    action: "settings_changed",
    actorId: userId,
    method: "admin",
    detail: "siem",
    ip,
  });
}

export type SiemPayload = {
  action: AuthAction;
  userId: string | null;
  actorId: string | null;
  method: string | null;
  detail: string | null;
  ip: string | null;
  occurredAt: string;
};

/** Queues a SIEM delivery when the action is watched and a URL is set. */
export async function queueSiemEvent(
  db: Database,
  event: {
    action: AuthAction;
    userId?: string | null;
    actorId?: string | null;
    method?: string | null;
    detail?: string | null;
    ip?: string | null;
  },
): Promise<void> {
  if (!SIEM_ACTIONS.has(event.action)) return;
  const row = await loadSiemRow(db);
  if (!row) return;
  const payload: SiemPayload = {
    action: event.action,
    userId: event.userId ?? null,
    actorId: event.actorId ?? null,
    method: event.method ?? null,
    detail: event.detail ?? null,
    ip: event.ip ?? null,
    occurredAt: new Date().toISOString(),
  };
  await addJob(db, TASKS.siemEvent, payload, { maxAttempts: 3 });
}

export async function deliverSiemEvent(
  db: Database,
  key: Buffer,
  payload: SiemPayload,
): Promise<void> {
  const row = await loadSiemRow(db);
  if (!row) return;
  const secret = decryptSecret(row.secretCiphertext, row.secretNonce, key);
  const body = JSON.stringify({
    source: "anygriddb",
    ...payload,
  });
  const status = await postPinned(row.url, body, {
    "content-type": "application/json",
    "x-anygriddb-signature": signBody(secret, body),
  });
  if (status < 200 || status >= 300) {
    throw new AppError("invalid_delivery", `HTTP ${status}`);
  }
}

/** Sends a test event to the saved URL. */
export async function sendSiemTest(
  db: Database,
  key: Buffer,
  actorId: string,
): Promise<void> {
  const row = await loadSiemRow(db);
  if (!row) throw new AppError("invalid_webhook");
  await deliverSiemEvent(db, key, {
    action: "settings_changed",
    userId: null,
    actorId,
    method: "admin",
    detail: "siem",
    ip: null,
    occurredAt: new Date().toISOString(),
  });
}
