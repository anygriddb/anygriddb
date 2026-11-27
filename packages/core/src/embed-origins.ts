/**
 * Origins allowed to embed a public share (ADR 0067): HTTPS by default,
 * explicit list, never `*`. HTTP is accepted only on this machine
 * (loopback), as OAuth redirect URIs already are. Empty or null means the
 * share is not embeddable.
 */
import { ceilingOf } from "./limits";
import { z } from "zod";
import { AppError } from "./errors.js";

/** Cap on origins stored per share (matches the migration check). */
const MAX_EMBED_ORIGINS = ceilingOf("link.embed_origins");

/** True for the machine itself: localhost, ::1, or 127.0.0.0/8. */
function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    /^127\.\d+\.\d+\.\d+$/.test(host)
  );
}

/**
 * One origin: HTTPS anywhere, or HTTP on loopback only; optional port; no
 * path, query, hash, or credentials. Trailing slashes and a lone `/` path
 * are normalised away.
 */
export function isEmbedOrigin(value: string): boolean {
  if (value.length > 200 || value.includes("*")) return false;
  try {
    const url = new URL(value);
    if (url.protocol === "https:") {
      // ok
    } else if (url.protocol === "http:" && isLoopbackHost(url.hostname)) {
      // Local portals only (mirrors OAuth redirect URIs).
    } else {
      return false;
    }
    if (url.username || url.password) return false;
    if (url.search || url.hash) return false;
    if (url.pathname !== "/" && url.pathname !== "") return false;
    // Reject the string form that is not exactly the origin (e.g. path "/").
    return url.origin === value || `${url.origin}/` === value;
  } catch {
    return false;
  }
}

/** Canonical origin string (`https://host` or `https://host:port`). */
export function normalizeEmbedOrigin(value: string): string {
  if (!isEmbedOrigin(value)) {
    throw new AppError("invalid_embed_origin");
  }
  return new URL(value).origin;
}

/**
 * Validates and deduplicates a list. Empty input becomes null (not
 * embeddable). `*` or any non-HTTPS origin outside loopback is refused.
 */
export function normalizeEmbedOrigins(
  values: readonly string[] | null | undefined,
): string[] | null {
  if (values == null) return null;
  if (values.length === 0) return null;
  if (values.length > MAX_EMBED_ORIGINS) {
    throw new AppError("invalid_embed_origin");
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const origin = normalizeEmbedOrigin(trimmed);
    if (seen.has(origin)) continue;
    seen.add(origin);
    out.push(origin);
  }
  return out.length > 0 ? out : null;
}

/** Reads a stored jsonb value into a normalised list, or null. */
export function storedEmbedOrigins(value: unknown): string[] | null {
  if (value == null) return null;
  if (!Array.isArray(value)) return null;
  try {
    return normalizeEmbedOrigins(
      value.filter((item): item is string => typeof item === "string"),
    );
  } catch {
    return null;
  }
}

/** Optional input on create/update: null or [] clears embedding. */
export const embedOriginsInputSchema = z
  .array(z.string().max(200))
  .max(MAX_EMBED_ORIGINS)
  .nullable()
  .optional();
