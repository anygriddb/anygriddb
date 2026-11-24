import {
  AppError,
  INSTANCE_EVENT_TYPES,
  MAX_INTEGRATIONS,
  notifyProvider,
  parseProviderConfig,
  type InstanceEventType,
} from "@anygriddb/core";
import type { Database, Json } from "@anygriddb/db";
import type { KeyRing } from "../auth/key-ring.js";
import { decryptSecret, encryptSecret } from "../auth/crypto.js";
import { recordAuthEvent } from "../auth/auth-events.js";
import { readSettings } from "../settings.js";
import { assertOutboundTarget } from "../outbound/index.js";
import { appriseTargets } from "./providers/apprise.js";
import { gotifyTargets } from "./providers/gotify.js";
import { ntfyTargets } from "./providers/ntfy.js";
import { alertmanagerTargets, matrixTargets } from "./providers/rooms.js";
import { webhookTargets } from "./providers/webhook.js";

const NAME = /^\P{Cc}{1,80}$/u;

export type PublicIntegration = {
  id: string;
  provider: string;
  name: string;
  enabled: boolean;
  status: "active" | "error" | "disabled";
  config: Record<string, unknown>;
  /** Secret field names that have a value. Never the value. */
  secretsSet: string[];
  events: InstanceEventType[];
  consecutiveFailures: number;
  suppressedCount: number;
  lastDeliveryAt: string | null;
  lastError: string | null;
  updatedAt: string;
  schedules: string[];
};

export type PublicDelivery = {
  id: string;
  event: string;
  subject: string;
  status: "pending" | "success" | "failed";
  attempts: number;
  responseStatus: number | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
};

type IntegrationRow = {
  id: string;
  provider: string;
  name: string;
  enabled: boolean;
  status: string;
  config: unknown;
  secretsCiphertext: Buffer | null;
  secretsNonce: Buffer | null;
  events: unknown;
  consecutiveFailures: number;
  suppressedCount: number;
  lastDeliveryAt: Date | null;
  lastError: string | null;
  updatedAt: Date;
};

function asRecord(value: unknown): Record<string, unknown> {
  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !Buffer.isBuffer(value)
  ) {
    return value as Record<string, unknown>;
  }
  return {};
}

function asEvents(value: unknown): InstanceEventType[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is InstanceEventType =>
      typeof item === "string" &&
      (INSTANCE_EVENT_TYPES as readonly string[]).includes(item),
  );
}

export function asFields(
  value: unknown,
): Record<string, string | number | boolean> {
  const fields: Record<string, string | number | boolean> = {};
  for (const [key, item] of Object.entries(asRecord(value))) {
    if (
      typeof item === "string" ||
      typeof item === "number" ||
      typeof item === "boolean"
    ) {
      fields[key] = item;
    }
  }
  return fields;
}

function asStatus(value: string): PublicIntegration["status"] {
  if (value === "error" || value === "disabled") return value;
  return "active";
}

function secretsSet(secrets: unknown): string[] {
  return Object.entries(asRecord(secrets)).flatMap(([key, value]) => {
    if (typeof value === "string") return value.length > 0 ? [key] : [];
    if (
      value &&
      typeof value === "object" &&
      Object.keys(asRecord(value)).length > 0
    ) {
      return [key];
    }
    return [];
  });
}

function openSecrets(
  row: IntegrationRow,
  ring: KeyRing,
): Record<string, unknown> {
  if (!row.secretsCiphertext || !row.secretsNonce) return {};
  const text = decryptSecret(
    row.secretsCiphertext,
    row.secretsNonce,
    ring,
    "notify",
  );
  return asRecord(JSON.parse(text) as unknown);
}

function sealSecrets(
  secrets: Record<string, unknown>,
  ring: KeyRing,
): { secretsCiphertext: Buffer | null; secretsNonce: Buffer | null } {
  if (Object.keys(secrets).length === 0) {
    return { secretsCiphertext: null, secretsNonce: null };
  }
  const sealed = encryptSecret(JSON.stringify(secrets), ring, "notify");
  return {
    secretsCiphertext: sealed.ciphertext,
    secretsNonce: sealed.nonce,
  };
}

function mergeSecrets(
  previous: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...previous };
  for (const [key, value] of Object.entries(patch)) {
    if (typeof value === "string" && value === "") continue;
    next[key] = value;
  }
  return next;
}

function present(
  row: IntegrationRow,
  secrets: unknown,
  schedules: string[] = [],
): PublicIntegration {
  return {
    id: row.id,
    provider: row.provider,
    name: row.name,
    enabled: row.enabled,
    status: asStatus(row.status),
    config: asRecord(row.config),
    secretsSet: secretsSet(secrets),
    events: asEvents(row.events),
    consecutiveFailures: row.consecutiveFailures,
    suppressedCount: row.suppressedCount,
    lastDeliveryAt: row.lastDeliveryAt?.toISOString() ?? null,
    lastError: row.lastError,
    updatedAt: row.updatedAt.toISOString(),
    schedules,
  };
}

/** The collector, which is not a secret. */
function otlpTargets(config: unknown): string[] {
  if (
    config === null ||
    typeof config !== "object" ||
    !("endpoint" in config)
  ) {
    return [];
  }
  const endpoint = config.endpoint;
  return typeof endpoint === "string" ? [endpoint] : [];
}

/**
 * The store's host, without the public key. The key is a username in the
 * DSN, and a username is refused on every other address.
 */
function sentryTargets(secrets: unknown): string[] {
  if (secrets === null || typeof secrets !== "object" || !("dsn" in secrets)) {
    return [];
  }
  const dsn = secrets.dsn;
  if (typeof dsn !== "string") return [];
  try {
    const url = new URL(dsn);
    return [`${url.protocol}//${url.host}/`];
  } catch {
    return [];
  }
}

function urlsIn(value: unknown): string[] {
  if (typeof value === "string" && value.startsWith("https://")) return [value];
  if (Array.isArray(value)) return value.flatMap(urlsIn);
  if (value !== null && typeof value === "object" && !Buffer.isBuffer(value)) {
    return Object.values(value).flatMap(urlsIn);
  }
  return [];
}

const BUILTIN_SCHEDULES = new Set([
  "purge",
  "audit_purge",
  "trash_purge",
  "file_sweep",
  "backup",
]);

function assertSchedules(schedules: readonly string[]): void {
  for (const schedule of schedules) {
    if (BUILTIN_SCHEDULES.has(schedule)) continue;
    if (/^automation:[0-9a-f-]{36}$/i.test(schedule)) continue;
    throw new AppError("invalid_integration");
  }
}

async function replaceSchedules(
  db: Database,
  id: string,
  schedules: readonly string[],
): Promise<void> {
  await db
    .deleteFrom("integrationSchedules")
    .where("integrationId", "=", id)
    .execute();
  if (schedules.length === 0) return;
  await db
    .insertInto("integrationSchedules")
    .values(schedules.map((schedule) => ({ integrationId: id, schedule })))
    .execute();
}

/** The addresses a channel's settings name, its secrets apart. */
function configTargets(provider: string, config: unknown): string[] {
  switch (provider) {
    case "webhook":
      return webhookTargets(config);
    case "ntfy":
      return ntfyTargets(config);
    case "gotify":
      return gotifyTargets(config);
    case "apprise":
      return appriseTargets(config);
    case "matrix":
      return matrixTargets(config);
    case "alertmanager":
      return alertmanagerTargets(config);
    case "otlp":
      return otlpTargets(config);
    default:
      return [];
  }
}

async function targetsOf(
  provider: string,
  config: unknown,
  secrets: unknown,
  allowPrivate: boolean,
): Promise<void> {
  const urls = [
    ...configTargets(provider, config),
    ...(provider === "sentry" ? sentryTargets(secrets) : urlsIn(secrets)),
  ];
  for (const url of urls) {
    try {
      await assertOutboundTarget(url, { allowPrivate });
    } catch (error) {
      throw new AppError("invalid_notify_target", { cause: error });
    }
  }
}

function originOf(url: string): string {
  return URL.canParse(url) ? new URL(url).origin : url;
}

/**
 * A saved secret is sent only to the host it was entered for. A channel
 * moved to another one asks for it again: leaving the field blank would
 * otherwise hand it to the new address at the next delivery.
 */
function assertSecretsFollow(
  provider: string,
  before: unknown,
  after: unknown,
  previous: Record<string, unknown>,
  entered: Record<string, unknown>,
): void {
  const known = new Set(configTargets(provider, before).map(originOf));
  const moved = configTargets(provider, after).some(
    (url) => !known.has(originOf(url)),
  );
  if (!moved) return;
  const left = Object.entries(previous).some(
    ([key, value]) =>
      value !== "" &&
      value !== null &&
      value !== undefined &&
      (entered[key] === undefined || entered[key] === ""),
  );
  if (left) throw new AppError("notify_secret_again");
}

function assertName(name: string): void {
  if (!NAME.test(name)) throw new AppError("invalid_integration");
}

async function loadRow(db: Database, id: string): Promise<IntegrationRow> {
  const row = await db
    .selectFrom("instanceIntegrations")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();
  if (!row) throw new AppError("unknown_integration");
  return row;
}

export async function listIntegrations(
  db: Database,
  ring: KeyRing,
): Promise<PublicIntegration[]> {
  const rows = await db
    .selectFrom("instanceIntegrations")
    .selectAll()
    .orderBy("name", "asc")
    .orderBy("id", "asc")
    .limit(MAX_INTEGRATIONS)
    .execute();
  const links = await db
    .selectFrom("integrationSchedules")
    .select(["integrationId", "schedule"])
    .execute();
  const byId = new Map<string, string[]>();
  for (const link of links) {
    const current = byId.get(link.integrationId) ?? [];
    current.push(link.schedule);
    byId.set(link.integrationId, current);
  }
  return rows.map((row) => {
    let secrets: unknown;
    try {
      secrets = openSecrets(row, ring);
    } catch {
      secrets = {};
    }
    return present(row, secrets, byId.get(row.id) ?? []);
  });
}

export async function integrationDeliveries(
  db: Database,
  id: string,
): Promise<PublicDelivery[]> {
  const rows = await db
    .selectFrom("integrationDeliveries")
    .select([
      "id",
      "event",
      "subject",
      "status",
      "attempts",
      "responseStatus",
      "error",
      "createdAt",
      "finishedAt",
    ])
    .where("integrationId", "=", id)
    .orderBy("createdAt", "desc")
    .limit(50)
    .execute();
  return rows.map((row) => ({
    id: row.id,
    event: row.event,
    subject: row.subject,
    status:
      row.status === "success" || row.status === "failed"
        ? row.status
        : "pending",
    attempts: row.attempts,
    responseStatus: row.responseStatus,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  }));
}

export async function failingIntegrationCount(db: Database): Promise<number> {
  const row = await db
    .selectFrom("instanceIntegrations")
    .select((eb) => eb.fn.countAll<string>().as("count"))
    .where("status", "=", "error")
    .executeTakeFirst();
  return Number(row?.count ?? 0);
}

export async function createIntegration(
  db: Database,
  ring: KeyRing,
  actorId: string,
  input: {
    provider: string;
    name: string;
    events: readonly InstanceEventType[];
    schedules?: readonly string[];
    config: Record<string, unknown>;
    secrets: Record<string, unknown>;
  },
  ip?: string,
): Promise<PublicIntegration> {
  const provider = notifyProvider(input.provider);
  if (!provider) throw new AppError("invalid_integration");
  if (provider.singleton) {
    const existing = await db
      .selectFrom("instanceIntegrations")
      .select("id")
      .where("provider", "=", provider.id)
      .executeTakeFirst();
    if (existing) throw new AppError("invalid_integration");
  }
  assertName(input.name);
  const parsed = parseProviderConfig(
    input.provider,
    input.config,
    input.secrets,
  );
  const allowPrivate = (await readSettings(db)).notifyAllowPrivate;
  await targetsOf(input.provider, parsed.config, parsed.secrets, allowPrivate);
  const count = await db
    .selectFrom("instanceIntegrations")
    .select((eb) => eb.fn.countAll<string>().as("count"))
    .executeTakeFirst();
  if (Number(count?.count ?? 0) >= MAX_INTEGRATIONS) {
    throw new AppError("integration_limit");
  }
  const sealed = sealSecrets(asRecord(parsed.secrets), ring);
  const events = provider.subscribes ? [...new Set(input.events)] : [];
  const row = await db
    .insertInto("instanceIntegrations")
    .values({
      provider: input.provider,
      name: input.name,
      config: parsed.config as Json,
      events: events as unknown as Json,
      ...sealed,
      updatedBy: actorId,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await recordAuthEvent(db, {
    action: "settings_changed",
    actorId,
    method: "admin",
    detail: "notify",
    ip,
  });
  const schedules = provider.subscribes ? [] : [...(input.schedules ?? [])];
  if (!provider.subscribes) {
    assertSchedules(schedules);
    await replaceSchedules(db, row.id, schedules);
  }
  return present(row, parsed.secrets, schedules);
}

export async function updateIntegration(
  db: Database,
  ring: KeyRing,
  actorId: string,
  input: {
    id: string;
    name?: string;
    events?: readonly InstanceEventType[];
    schedules?: readonly string[];
    config?: Record<string, unknown>;
    secrets?: Record<string, unknown>;
  },
  ip?: string,
): Promise<PublicIntegration> {
  const current = await loadRow(db, input.id);
  const provider = notifyProvider(current.provider);
  if (!provider) throw new AppError("invalid_integration");
  if (input.name !== undefined) assertName(input.name);
  let previous: Record<string, unknown>;
  try {
    previous = openSecrets(current, ring);
  } catch (error) {
    throw new AppError("invalid_integration", { cause: error });
  }
  const secrets = mergeSecrets(previous, input.secrets ?? {});
  const config = input.config ?? asRecord(current.config);
  assertSecretsFollow(
    current.provider,
    current.config,
    config,
    previous,
    input.secrets ?? {},
  );
  const parsed = parseProviderConfig(current.provider, config, secrets);
  const allowPrivate = (await readSettings(db)).notifyAllowPrivate;
  await targetsOf(
    current.provider,
    parsed.config,
    parsed.secrets,
    allowPrivate,
  );
  const sealed = sealSecrets(asRecord(parsed.secrets), ring);
  const events = provider.subscribes
    ? [...new Set(input.events ?? asEvents(current.events))]
    : [];
  const row = await db
    .updateTable("instanceIntegrations")
    .set({
      name: input.name ?? current.name,
      config: parsed.config as Json,
      events: events as unknown as Json,
      ...sealed,
      consecutiveFailures: 0,
      status: current.enabled ? "active" : "disabled",
      lastError: null,
      updatedAt: new Date(),
      updatedBy: actorId,
    })
    .where("id", "=", input.id)
    .returningAll()
    .executeTakeFirstOrThrow();
  await recordAuthEvent(db, {
    action: "settings_changed",
    actorId,
    method: "admin",
    detail: "notify",
    ip,
  });
  if (!provider.subscribes && input.schedules) {
    assertSchedules(input.schedules);
    await replaceSchedules(db, row.id, input.schedules);
  }
  return present(row, parsed.secrets, [...(input.schedules ?? [])]);
}

export async function setIntegrationEnabled(
  db: Database,
  ring: KeyRing,
  actorId: string,
  id: string,
  enabled: boolean,
  ip?: string,
): Promise<PublicIntegration> {
  const current = await loadRow(db, id);
  const row = await db
    .updateTable("instanceIntegrations")
    .set({
      enabled,
      status: enabled ? "active" : "disabled",
      consecutiveFailures: enabled ? 0 : current.consecutiveFailures,
      updatedAt: new Date(),
      updatedBy: actorId,
    })
    .where("id", "=", id)
    .returningAll()
    .executeTakeFirstOrThrow();
  await recordAuthEvent(db, {
    action: "settings_changed",
    actorId,
    method: "admin",
    detail: "notify",
    ip,
  });
  let secrets: unknown;
  try {
    secrets = openSecrets(row, ring);
  } catch {
    secrets = {};
  }
  return present(row, secrets);
}

export async function deleteIntegration(
  db: Database,
  actorId: string,
  id: string,
  ip?: string,
): Promise<{ id: string; provider: string }> {
  const removed = await db
    .deleteFrom("instanceIntegrations")
    .where("id", "=", id)
    .returning(["id", "provider"])
    .executeTakeFirst();
  if (!removed) throw new AppError("unknown_integration");
  await recordAuthEvent(db, {
    action: "settings_changed",
    actorId,
    method: "admin",
    detail: "notify",
    ip,
  });
  return { id: removed.id, provider: removed.provider };
}
