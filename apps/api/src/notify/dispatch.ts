import { randomUUID } from "node:crypto";
import {
  AppError,
  heartbeatSecretsSchema,
  NOTIFY_DEDUPE_MS,
  NOTIFY_FAILURE_LIMIT,
  jobEventType,
  notifyProvider,
  rateDecision,
  type InstanceEventType,
} from "@anygriddb/core";
import type { Database, DeliveryRow } from "@anygriddb/db";
import { sql } from "kysely";
import type { KeyRing } from "../auth/key-ring.js";
import { decryptSecret } from "../auth/crypto.js";
import type { SqlExecutor } from "../queue/jobs.js";
import {
  addDeliveries,
  noteDelivery,
  type Destination,
} from "../outbound/deliveries.js";
import type { Env } from "../env.js";
import { resolveSmtp } from "../integrations/smtp.js";
import { sendMail, smtpReady } from "../mail.js";
import { readMailVoice, readSettings } from "../settings.js";
import { redactSecrets, secretStrings } from "../outbound/index.js";
import {
  notifyFailureText,
  sendOutbound,
  type Outbound,
  type OutboundResponse,
} from "./outbound.js";
import { sendApprise } from "./providers/apprise.js";
import { sendGotify } from "./providers/gotify.js";
import { sendNtfy } from "./providers/ntfy.js";
import {
  sendAlertmanager,
  sendMattermost,
  sendMatrix,
  sendRocketChat,
  sendZulip,
} from "./providers/rooms.js";
import { sendSmtpChannel } from "./providers/smtp.js";
import { sendWebhook, type NotifyPayload } from "./providers/webhook.js";
import { heartbeatAccepted, heartbeatTarget } from "./pulse.js";
import { captureServerError, sendSentry } from "./sentry.js";
import { asFields } from "./store.js";

type Log = (error: unknown, message: string) => void;

export type NotifyRuntime = {
  db: Database;
  key: KeyRing;
  log: Log;
  send?: Outbound;
  env?: Env;
};

type StoredEvent = {
  id: string;
  type: InstanceEventType;
  at: string;
  subject: string;
  fields: Record<string, string | number | boolean>;
};

type MailSender = (message: {
  to: string;
  subject: string;
  text: string;
}) => Promise<void>;

const SENDERS = {
  webhook: sendWebhook,
  ntfy: sendNtfy,
  gotify: sendGotify,
  apprise: sendApprise,
  smtp: sendSmtpChannel,
  matrix: sendMatrix,
  mattermost: sendMattermost,
  rocketchat: sendRocketChat,
  zulip: sendZulip,
  alertmanager: sendAlertmanager,
  sentry: sendSentry,
} as const;

async function mailFor(deps: NotifyRuntime): Promise<MailSender | undefined> {
  if (!deps.env) return undefined;
  const { config } = await resolveSmtp(deps.db, deps.env);
  if (!smtpReady(config)) return undefined;
  const voice = await readMailVoice(deps.db);
  return (message) => sendMail(config, voice, message);
}

function senderFor(provider: string) {
  if (provider === "webhook") return SENDERS.webhook;
  if (provider === "ntfy") return SENDERS.ntfy;
  if (provider === "gotify") return SENDERS.gotify;
  if (provider === "apprise") return SENDERS.apprise;
  if (provider === "smtp") return SENDERS.smtp;
  if (provider === "matrix") return SENDERS.matrix;
  if (provider === "mattermost") return SENDERS.mattermost;
  if (provider === "rocketchat") return SENDERS.rocketchat;
  if (provider === "zulip") return SENDERS.zulip;
  if (provider === "alertmanager") return SENDERS.alertmanager;
  if (provider === "sentry") return SENDERS.sentry;
  return undefined;
}

/**
 * Tells every active channel subscribed to this event. A failure here is
 * logged and swallowed: the operation that emitted the event already
 * succeeded, and must not fail because a channel is down.
 */
export async function emitInstanceEvent(
  db: Database,
  log: Log,
  event: Omit<StoredEvent, "id" | "at"> & { id?: string; at?: string },
): Promise<void> {
  const stored: StoredEvent = {
    id: event.id ?? randomUUID(),
    type: event.type,
    at: event.at ?? new Date().toISOString(),
    subject: event.subject,
    fields: event.fields,
  };
  try {
    await db.transaction().execute((tx) => queueEvent(tx, stored));
  } catch (error) {
    log(error, "notification was not queued");
  }
}

async function queueEvent(tx: SqlExecutor, event: StoredEvent): Promise<void> {
  const channels = await tx
    .selectFrom("instanceIntegrations")
    .select("id")
    .where("enabled", "=", true)
    .where("status", "=", "active")
    .orderBy("id", "asc")
    .execute();
  const now = Date.now();
  for (const channel of channels) {
    const row = await tx
      .selectFrom("instanceIntegrations")
      .selectAll()
      .where("id", "=", channel.id)
      .where("enabled", "=", true)
      .where("status", "=", "active")
      .forUpdate()
      .executeTakeFirst();
    if (!row) continue;
    const provider = notifyProvider(row.provider);
    if (!provider?.subscribes) continue;
    const events = Array.isArray(row.events) ? row.events : [];
    if (!events.includes(event.type)) continue;
    if (event.type === "integration.failing" && event.subject === row.id) {
      continue;
    }
    const recent = await tx
      .selectFrom("deliveries")
      .select("createdAt")
      .where("integrationId", "=", row.id)
      .where("event", "=", event.type)
      .where("subject", "=", event.subject)
      .where("createdAt", ">", new Date(now - NOTIFY_DEDUPE_MS))
      .orderBy("createdAt", "desc")
      .limit(1)
      .executeTakeFirst();
    const decision = rateDecision(
      {
        now,
        windowStartedAt: row.rateWindowStartedAt?.getTime() ?? null,
        sent: row.rateSent,
        lastSameAt: recent?.createdAt.getTime() ?? null,
      },
      row.suppressedCount,
    );
    await tx
      .updateTable("instanceIntegrations")
      .set({
        rateWindowStartedAt: new Date(decision.windowStartedAt),
        rateSent: decision.sent,
        suppressedCount: decision.suppressed,
      })
      .where("id", "=", row.id)
      .execute();
    if (decision.action === "suppress") continue;
    await addDeliveries(tx, [
      {
        integrationId: row.id,
        eventId: event.id,
        event: event.type,
        subject: event.subject,
        payload: event.fields,
      },
    ]);
  }
}

type Channel = {
  id: string;
  provider: string;
  config: unknown;
  secretsCiphertext: Buffer | null;
  secretsNonce: Buffer | null;
};

function payloadOf(delivery: DeliveryRow): NotifyPayload {
  return {
    id: delivery.eventId ?? delivery.id,
    type: delivery.event,
    at: delivery.createdAt.toISOString(),
    subject: delivery.subject,
    fields: asFields(delivery.payload),
  };
}

function openedSecrets(
  sealed: { secretsCiphertext: Buffer | null; secretsNonce: Buffer | null },
  key: KeyRing,
): unknown {
  if (!sealed.secretsCiphertext || !sealed.secretsNonce) return {};
  return JSON.parse(
    decryptSecret(sealed.secretsCiphertext, sealed.secretsNonce, key, "notify"),
  ) as unknown;
}

/** One attempt to a channel: what it answered, or why it did not. */
async function sendToChannel(
  deps: NotifyRuntime,
  channel: Channel,
  delivery: DeliveryRow,
): Promise<{ status: number | null; failure?: string }> {
  const send = senderFor(channel.provider);
  const outbound = deps.send ?? sendOutbound;
  let response: OutboundResponse | undefined;
  try {
    if (!send) throw new Error("Unknown provider");
    const allowPrivate = (await readSettings(deps.db)).notifyAllowPrivate;
    response = await send({
      config: channel.config,
      secrets: openedSecrets(channel, deps.key),
      event: payloadOf(delivery),
      send: outbound,
      allowPrivate,
      mail: await mailFor(deps),
    });
  } catch (error) {
    const failure = notifyFailureText(error);
    if (failure === "Network error") {
      deps.log(error, "notification delivery failed");
    }
    return { status: null, failure: failure.slice(0, 200) };
  }
  return response.status < 200 || response.status >= 300
    ? { status: response.status, failure: `HTTP ${String(response.status)}` }
    : { status: response.status };
}

/**
 * How the journal sends a channel's deliveries. Its failures are retried
 * on the journal's schedule; the channel pauses once too many gave up in a
 * row, and says so on the others.
 */
export function channelDestination(deps: NotifyRuntime): Destination {
  return {
    attempt: async (delivery) => {
      const channel =
        delivery.integrationId === null
          ? undefined
          : await deps.db
              .selectFrom("instanceIntegrations")
              .select([
                "id",
                "provider",
                "config",
                "secretsCiphertext",
                "secretsNonce",
              ])
              .where("id", "=", delivery.integrationId)
              .executeTakeFirst();
      if (!channel) return { refused: "Unknown provider" };
      const { status, failure } = await sendToChannel(deps, channel, delivery);
      return failure === undefined
        ? { sent: true, status }
        : { sent: false, status, error: failure };
    },
    delivered: async (delivery) => {
      if (delivery.integrationId !== null) {
        await noteSuccess(deps.db, delivery.integrationId);
      }
    },
    retrying: async (delivery, error) => {
      if (delivery.integrationId === null) return;
      await deps.db
        .updateTable("instanceIntegrations")
        .set({ lastError: error, updatedAt: new Date() })
        .where("id", "=", delivery.integrationId)
        .execute();
    },
    gaveUp: async (delivery, error) => {
      if (delivery.integrationId === null) return;
      const paused = await noteFailure(deps.db, delivery.integrationId, error);
      if (!paused) return;
      const channel = await deps.db
        .selectFrom("instanceIntegrations")
        .select("provider")
        .where("id", "=", delivery.integrationId)
        .executeTakeFirst();
      await emitInstanceEvent(deps.db, deps.log, {
        type: "integration.failing",
        subject: delivery.integrationId,
        fields: { provider: channel?.provider ?? "" },
      });
    },
  };
}

async function noteSuccess(db: Database, integrationId: string): Promise<void> {
  await db
    .updateTable("instanceIntegrations")
    .set({
      consecutiveFailures: 0,
      status: sql`case when status = 'disabled' then status else 'active' end`,
      lastError: null,
      lastDeliveryAt: new Date(),
      updatedAt: new Date(),
    })
    .where("id", "=", integrationId)
    .execute();
}

/** True when this failure is the one that pauses the channel. */
async function noteFailure(
  db: Database,
  integrationId: string,
  errorText: string,
): Promise<boolean> {
  const updated = await db
    .updateTable("instanceIntegrations")
    .set({
      consecutiveFailures: sql`consecutive_failures + 1`,
      status: sql`case when status = 'disabled' then status when consecutive_failures + 1 >= ${NOTIFY_FAILURE_LIMIT} then 'error' else status end`,
      lastError: errorText,
      lastDeliveryAt: new Date(),
      updatedAt: new Date(),
    })
    .where("id", "=", integrationId)
    .returning("consecutiveFailures")
    .executeTakeFirst();
  return Number(updated?.consecutiveFailures) === NOTIFY_FAILURE_LIMIT;
}

export type TestResult = {
  ok: boolean;
  status: number | null;
  error: string | null;
  body: string;
};

/** Sends once, in the request, so the screen can show what came back. */
export async function testIntegration(
  deps: NotifyRuntime,
  integrationId: string,
): Promise<TestResult> {
  const row = await deps.db
    .selectFrom("instanceIntegrations")
    .selectAll()
    .where("id", "=", integrationId)
    .executeTakeFirst();
  if (!row) throw new AppError("unknown_integration");
  const provider = notifyProvider(row.provider);
  if (!provider) throw new AppError("unknown_integration");
  const outbound = deps.send ?? sendOutbound;
  const event: NotifyPayload = {
    id: randomUUID(),
    type: "test",
    at: new Date().toISOString(),
    subject: "test",
    fields: {},
  };
  let secrets: unknown = {};
  let response: OutboundResponse | undefined;
  let failure: string | undefined;
  try {
    secrets = openedSecrets(row, deps.key);
    const allowPrivate = (await readSettings(deps.db)).notifyAllowPrivate;
    if (provider.family === "heartbeat") {
      // A heartbeat has no event sender: the test is one success ping.
      const parsed = heartbeatSecretsSchema.parse(secrets);
      const url = heartbeatTarget(row.provider, parsed, "success");
      if (!url) throw new AppError("invalid_integration");
      response = await outbound({ url, method: "GET" }, allowPrivate);
      if (!heartbeatAccepted(row.provider, response)) {
        failure = `HTTP ${String(response.status)}`;
      }
    } else {
      const send = senderFor(row.provider);
      if (!send) throw new Error("Unknown provider");
      response = await send({
        config: row.config,
        secrets,
        mail: await mailFor(deps),
        event,
        send: outbound,
        allowPrivate,
      });
      if (response.status < 200 || response.status >= 300) {
        failure = `HTTP ${String(response.status)}`;
      }
    }
  } catch (error) {
    failure = notifyFailureText(error);
  }
  const errorText = failure?.slice(0, 200) ?? null;
  await noteDelivery(deps.db, {
    integrationId: row.id,
    eventId: event.id,
    event: "test",
    subject: "test",
    status: failure ? "failed" : "success",
    responseStatus: response?.status ?? null,
    error: errorText,
  });
  if (!failure) await noteSuccess(deps.db, row.id);
  else if (await noteFailure(deps.db, row.id, errorText ?? "Network error")) {
    await emitInstanceEvent(deps.db, deps.log, {
      type: "integration.failing",
      subject: row.id,
      fields: { provider: row.provider },
    });
  }
  const body = redactSecrets(response?.body ?? "", secretStrings(secrets));
  return {
    ok: !failure,
    status: response?.status ?? null,
    error: errorText,
    body,
  };
}

/** A finished product job. An import failure is `import.failed`, not both. */
export async function notifyJobOutcome(
  db: Database,
  log: Log,
  job: {
    id: string;
    kind: string;
    status: "done" | "failed";
    errorCode: string | null;
  },
  key?: KeyRing,
): Promise<void> {
  const type = jobEventType(job.kind, job.status);
  if (!type) return;
  await emitInstanceEvent(db, log, {
    type,
    subject: job.id,
    fields: {
      kind: job.kind,
      ...(job.errorCode ? { code: job.errorCode } : {}),
    },
  });
  if (job.status !== "failed" || !key) return;
  await captureServerError(db, key).catch((error: unknown) => {
    log(error, "error report failed");
  });
}
