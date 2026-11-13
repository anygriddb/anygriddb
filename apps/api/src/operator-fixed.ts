/**
 * What the operator fixed where the instance is installed (ROADMAP #46):
 * the address people open, where files are kept, and the proxies whose
 * word is taken for a client's address. Read-only, for Administration,
 * and without a secret: never a key, a password, or a part of one.
 */
import type { Env } from "./env.js";

export type OperatorFixedStorage =
  | { driver: "disk"; path: string }
  | {
      driver: "s3";
      bucket: string;
      endpointHost: string | null;
      region: string | null;
      encryption: "AES256" | "aws:kms" | null;
    };

export type OperatorFixed = {
  publicUrl: string;
  storage: OperatorFixedStorage;
  trustedProxies: readonly string[];
};

/** Host of an HTTPS endpoint URL, or null when the value is not a URL. */
export function endpointHost(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    return new URL(raw).host || null;
  } catch {
    return null;
  }
}

/** Facts an administrator may see; never keys, passwords, or tokens. */
export function operatorFixedFromEnv(env: Env): OperatorFixed {
  const storage: OperatorFixedStorage =
    env.STORAGE_DRIVER === "s3"
      ? {
          driver: "s3",
          bucket: env.S3_BUCKET ?? "",
          endpointHost: endpointHost(env.S3_ENDPOINT),
          region: env.S3_REGION ?? null,
          encryption: env.S3_SERVER_SIDE_ENCRYPTION ?? null,
        }
      : { driver: "disk", path: env.STORAGE_PATH };
  return {
    publicUrl: env.PUBLIC_URL,
    storage,
    trustedProxies: [...env.TRUSTED_PROXIES],
  };
}
