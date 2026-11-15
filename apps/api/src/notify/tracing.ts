import { otlpConfigSchema, otlpSecretsSchema } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import type { KeyRing } from "../auth/key-ring.js";
import { decryptSecret } from "../auth/crypto.js";
import { startTracing } from "../observability.js";

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

/** The saved collector, when the environment did not name one. */
export async function savedTracing(
  db: Database,
  key: KeyRing,
): Promise<{ endpoint?: string; headers?: string }> {
  const row = await db
    .selectFrom("instanceIntegrations")
    .select(["config", "secretsCiphertext", "secretsNonce", "enabled"])
    .where("provider", "=", "otlp")
    .executeTakeFirst();
  if (!row?.enabled) return {};
  const config = otlpConfigSchema.safeParse(row.config);
  if (!config.success) return {};
  let headers: string | undefined;
  if (row.secretsCiphertext && row.secretsNonce) {
    const secrets = otlpSecretsSchema.parse(
      JSON.parse(
        decryptSecret(row.secretsCiphertext, row.secretsNonce, key, "notify"),
      ),
    );
    headers = secrets.headers;
  }
  return { endpoint: config.data.endpoint, ...(headers ? { headers } : {}) };
}

export async function stopCurrentTracing(): Promise<void> {
  await stop();
}
