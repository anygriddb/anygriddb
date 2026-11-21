import { isIP, type LookupFunction } from "node:net";
import { otlpConfigSchema, otlpSecretsSchema } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import type { KeyRing } from "../auth/key-ring.js";
import { decryptSecret } from "../auth/crypto.js";
import { startTracing } from "../observability.js";
import { readSettings } from "../settings.js";
import { notifyLookup } from "./outbound.js";
import { isNotifyBlocked } from "./target.js";

let stop = async () => {
  await Promise.resolve();
};

export type TracingState = "off" | "live" | "restart";

/**
 * Starts or replaces the trace exporter. The environment wins. A second
 * start that the library refuses is reported as needing a restart.
 */
export async function applyTracing(settings: {
  endpoint?: string | undefined;
  headers?: string | undefined;
  lookup?: LookupFunction | undefined;
  serviceName: string;
  version: string;
}): Promise<TracingState> {
  try {
    await stop();
    stop = await startTracing(settings);
    return settings.endpoint ? "live" : "off";
  } catch {
    return "restart";
  }
}

/**
 * DNS for a collector saved in Administration, held to what a notification
 * channel is at each connection: a name that comes to point at this machine
 * or a private network is refused, and the switch is read as it stands.
 */
function collectorLookup(db: Database): LookupFunction {
  return (hostname, options, callback) => {
    readSettings(db).then(
      (settings) => {
        notifyLookup(settings.notifyAllowPrivate)(hostname, options, callback);
      },
      (error: unknown) => {
        callback(
          error instanceof Error ? error : new Error("Lookup failed"),
          "",
          0,
        );
      },
    );
  };
}

/** An address written as an IP asks no DNS: it is checked here. */
function blockedAddress(endpoint: string, allowPrivate: boolean): boolean {
  const host = new URL(endpoint).hostname.replace(/^\[|\]$/g, "");
  const family = isIP(host);
  return family !== 0 && isNotifyBlocked(host, family, allowPrivate);
}

/** The saved collector, when the environment did not name one. */
export async function savedTracing(
  db: Database,
  key: KeyRing,
): Promise<{ endpoint?: string; headers?: string; lookup?: LookupFunction }> {
  const row = await db
    .selectFrom("instanceIntegrations")
    .select(["config", "secretsCiphertext", "secretsNonce", "enabled"])
    .where("provider", "=", "otlp")
    .executeTakeFirst();
  if (!row?.enabled) return {};
  const config = otlpConfigSchema.safeParse(row.config);
  if (!config.success) return {};
  const { notifyAllowPrivate } = await readSettings(db);
  if (blockedAddress(config.data.endpoint, notifyAllowPrivate)) return {};
  let headers: string | undefined;
  if (row.secretsCiphertext && row.secretsNonce) {
    const secrets = otlpSecretsSchema.parse(
      JSON.parse(
        decryptSecret(row.secretsCiphertext, row.secretsNonce, key, "notify"),
      ),
    );
    headers = secrets.headers;
  }
  return {
    endpoint: config.data.endpoint,
    ...(headers ? { headers } : {}),
    lookup: collectorLookup(db),
  };
}

export async function stopCurrentTracing(): Promise<void> {
  await stop();
}
