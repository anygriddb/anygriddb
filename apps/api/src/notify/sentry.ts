import { randomUUID } from "node:crypto";
import { AppError, sentrySecretsSchema } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import type { KeyRing } from "../auth/key-ring.js";
import { decryptSecret } from "../auth/crypto.js";
import { readSettings } from "../settings.js";
import {
  requestOutbound,
  type Outbound,
  type OutboundResponse,
} from "./outbound.js";
import type { NotifyPayload } from "./providers/webhook.js";

let cached: { at: number; dsn: string | undefined } | undefined;

/**
 * The envelope Sentry's HTTP store accepts. The public key stays in the
 * auth header. The body names the kind of failure only: no message, no
 * request, no address.
 */
export function buildSentryEnvelope(
  dsn: string,
  now: Date,
  eventId: string,
): { url: string; auth: string; body: string } | undefined {
  let parsed: URL;
  try {
    parsed = new URL(dsn);
  } catch {
    return undefined;
  }
  const project = parsed.pathname.replace(/^\//, "").split("/")[0];
  if (!project || !parsed.username || parsed.protocol !== "https:") {
    return undefined;
  }
  const key = decodeURIComponent(parsed.username);
  const header = JSON.stringify({
    event_id: eventId,
    sent_at: now.toISOString(),
  });
  const item = JSON.stringify({
    type: "event",
    content_type: "application/json",
  });
  const payload = JSON.stringify({
    event_id: eventId,
    timestamp: now.toISOString(),
    platform: "node",
    level: "error",
    exception: { values: [{ type: "Error", value: "internal" }] },
  });
  return {
    url: `${parsed.protocol}//${parsed.host}/api/${project}/envelope/`,
    auth: `Sentry sentry_version=7, sentry_key=${key}`,
    body: `${header}\n${item}\n${payload}`,
  };
}

async function savedDsn(
  db: Database,
  key: KeyRing,
): Promise<string | undefined> {
  const now = Date.now();
  if (cached && now - cached.at < 5_000) return cached.dsn;
  let dsn: string | undefined;
  try {
    const row = await db
      .selectFrom("instanceIntegrations")
      .select(["secretsCiphertext", "secretsNonce", "enabled"])
      .where("provider", "=", "sentry")
      .executeTakeFirst();
    if (row?.enabled && row.secretsCiphertext && row.secretsNonce) {
      const secrets = sentrySecretsSchema.parse(
        JSON.parse(
          decryptSecret(row.secretsCiphertext, row.secretsNonce, key, "notify"),
        ),
      );
      dsn = secrets.dsn;
    }
  } catch {
    dsn = undefined;
  }
  cached = { at: now, dsn };
  return dsn;
}

/** Posts one envelope when a DSN is saved. Does nothing otherwise. */
export async function captureServerError(
  db: Database,
  key: KeyRing,
): Promise<void> {
  const dsn = await savedDsn(db, key);
  if (!dsn) return;
  const envelope = buildSentryEnvelope(
    dsn,
    new Date(),
    randomUUID().replace(/-/g, ""),
  );
  if (!envelope) return;
  const allowPrivate = (await readSettings(db)).notifyAllowPrivate;
  await requestOutbound(
    {
      url: envelope.url,
      method: "POST",
      headers: {
        "content-type": "application/x-sentry-envelope",
        "x-sentry-auth": envelope.auth,
      },
      body: envelope.body,
    },
    allowPrivate,
  );
}

export function clearSentryDsn(): void {
  cached = undefined;
}

/** One envelope, through the same transport as every other channel. */
export function sendSentry(input: {
  config?: unknown;
  secrets: unknown;
  event: NotifyPayload;
  send: Outbound;
  allowPrivate: boolean;
  mail?: unknown;
}): Promise<OutboundResponse> {
  const secrets = sentrySecretsSchema.parse(input.secrets);
  const envelope = buildSentryEnvelope(
    secrets.dsn,
    new Date(input.event.at),
    input.event.id.replace(/-/g, ""),
  );
  if (!envelope) throw new AppError("invalid_notify_target");
  return input.send(
    {
      url: envelope.url,
      method: "POST",
      headers: {
        "content-type": "application/x-sentry-envelope",
        "x-sentry-auth": envelope.auth,
      },
      body: envelope.body,
    },
    input.allowPrivate,
  );
}
