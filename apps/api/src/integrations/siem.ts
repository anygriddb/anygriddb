/**
 * Optional SIEM webhook (ADR 0056): posts selected auth_events to an
 * operator HTTPS URL. Secrets stay sealed; payloads never hold emails.
 */
import type { KeyRing } from "../auth/key-ring.js";
import { AppError } from "@anygriddb/core";
import type { AuthAction, Database } from "@anygriddb/db";
import { z } from "zod";
import { decryptSecret, encryptSecret } from "../auth/crypto.js";
import { recordAuthEvent } from "../auth/auth-events.js";
import { addJob, TASKS } from "../queue/jobs.js";
import { postOutbound } from "../outbound/index.js";
import { assertPublicHttps, signBody } from "../webhooks.js";

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
  "token_created",
  "install_token_issued",
  "install_token_used",
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

type PublicSiem = {
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

type SiemUpdate = z.infer<typeof siemUpdateSchema>;

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
  key: KeyRing,
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
    const sealed = encryptSecret(input.secret, key, "siem");
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

/** An event of the sign-in trail, as it is recorded. */
export type CollectorEvent = {
  action: AuthAction;
  userId?: string | null;
  actorId?: string | null;
  method?: string | null;
  detail?: string | null;
  ip?: string | null;
};

/** What a collector gets of it: ids and codes, never a person's address. */
export type CollectorPayload = {
  action: AuthAction;
  userId: string | null;
  actorId: string | null;
  method: string | null;
  detail: string | null;
  ip: string | null;
  occurredAt: string;
};

/**
 * What an event sends to a collector, or null for one no collector is
 * sent. One list and one shape, for the HTTPS collector and for syslog
 * (ADR 0084).
 */
export function collectorPayload(
  event: CollectorEvent,
): CollectorPayload | null {
  if (!SIEM_ACTIONS.has(event.action)) return null;
  return {
    action: event.action,
    userId: event.userId ?? null,
    actorId: event.actorId ?? null,
    method: event.method ?? null,
    detail: event.detail ?? null,
    ip: event.ip ?? null,
    occurredAt: new Date().toISOString(),
  };
}

/** Queues a SIEM delivery when the action is watched and a URL is set. */
export async function queueSiemEvent(
  db: Database,
  event: CollectorEvent,
): Promise<void> {
  const payload = collectorPayload(event);
  if (!payload) return;
  const row = await loadSiemRow(db);
  if (!row) return;
  await addJob(db, TASKS.siemEvent, payload, { maxAttempts: 3 });
}

export async function deliverSiemEvent(
  db: Database,
  key: KeyRing,
  payload: CollectorPayload,
): Promise<void> {
  await postToSiem(
    db,
    key,
    JSON.stringify({
      source: "anygriddb",
      ...payload,
    }),
  );
}

/**
 * Posts a JSON body to the collector saved in Administration, signed with
 * its secret. Answers false when none is saved; a refusal is thrown.
 */
export async function postToSiem(
  db: Database,
  key: KeyRing,
  body: string,
): Promise<boolean> {
  const row = await loadSiemRow(db);
  if (!row) return false;
  const secret = decryptSecret(
    row.secretCiphertext,
    row.secretNonce,
    key,
    "siem",
  );
  const status = await postOutbound(row.url, body, {
    "content-type": "application/json",
    "x-anygriddb-signature": signBody(secret, body),
  });
  if (status < 200 || status >= 300) {
    throw new AppError("invalid_delivery", `HTTP ${status}`);
  }
  return true;
}

/** Sends a test event to the saved URL. */
export async function sendSiemTest(
  db: Database,
  key: KeyRing,
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
