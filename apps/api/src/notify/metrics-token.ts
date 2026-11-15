import { metricsSecretsSchema } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { decryptSecret } from "../auth/crypto.js";
import type { Env } from "../env.js";

let cached: { at: number; token: string | undefined } | undefined;

/** The bearer for `/metrics`: the environment wins, otherwise the saved token. */
export async function metricsBearer(
  db: Database,
  env: Env,
): Promise<string | undefined> {
  if (env.METRICS_TOKEN) return env.METRICS_TOKEN;
  const now = Date.now();
  if (cached && now - cached.at < 5_000) return cached.token;
  let token: string | undefined;
  try {
    const row = await db
      .selectFrom("instanceIntegrations")
      .select(["secretsCiphertext", "secretsNonce", "enabled"])
      .where("provider", "=", "metrics")
      .executeTakeFirst();
    if (row?.enabled && row.secretsCiphertext && row.secretsNonce) {
      const secrets = metricsSecretsSchema.parse(
        JSON.parse(
          decryptSecret(
            row.secretsCiphertext,
            row.secretsNonce,
            env.AUTH_ENCRYPTION_KEY,
            "notify",
          ),
        ),
      );
      token = secrets.token;
    }
  } catch {
    token = undefined;
  }
  cached = { at: now, token };
  return token;
}

export function clearMetricsBearer(): void {
  cached = undefined;
}
