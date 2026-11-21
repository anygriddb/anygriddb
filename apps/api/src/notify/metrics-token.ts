import { metricsSecretsSchema } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { decryptSecret } from "../auth/crypto.js";
import type { Env } from "../env.js";
import { scrapeReader } from "../observability.js";

function readSavedToken(db: Database) {
  return db
    .selectFrom("instanceIntegrations")
    .select(["secretsCiphertext", "secretsNonce", "enabled"])
    .where("provider", "=", "metrics")
    .executeTakeFirst();
}

// In an object: no row found is not a read that failed.
type SavedTokenRead = { row: Awaited<ReturnType<typeof readSavedToken>> };

let readSaved = scrapeReader<SavedTokenRead>();
let cached: { at: number; token: string | undefined } | undefined;

/** The bearer for `/metrics`: the environment wins, otherwise the saved token. */
export async function metricsBearer(
  db: Database,
  env: Env,
): Promise<string | undefined> {
  if (env.METRICS_TOKEN) return env.METRICS_TOKEN;
  const now = Date.now();
  if (cached && now - cached.at < 5_000) return cached.token;
  const read = await readSaved(async () => ({
    row: await readSavedToken(db),
  }));
  // The database does not answer: the token last read still opens the
  // scrape that tells of it. This route needs no sign-in, so a failed read
  // is remembered like any other and callers cannot queue more of them.
  if (!read) {
    cached = { at: now, token: cached?.token };
    return cached.token;
  }
  const { row } = read;
  let token: string | undefined;
  try {
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

/** A token saved or removed: what was read, or is being read, is void. */
export function clearMetricsBearer(): void {
  cached = undefined;
  readSaved = scrapeReader<SavedTokenRead>();
}
