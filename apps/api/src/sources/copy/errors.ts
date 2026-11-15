/**
 * What went wrong reaching a store, as an administrator can fix it; never
 * the driver's own text, which may quote an address or a name.
 */
import { AppError } from "@anygriddb/core";

const TLS_CODES = new Set([
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

/** A server that answers a TLS hello with something else speaks none. */
const NO_TLS_CODES = new Set([
  "ERR_SSL_WRONG_VERSION_NUMBER",
  "ERR_SSL_PACKET_LENGTH_TOO_LONG",
  "ERR_SSL_UNEXPECTED_EOF_WHILE_READING",
  "ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION",
]);

const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
]);

const TIMEOUT_CODES = new Set(["ETIMEDOUT", "ESOCKETTIMEDOUT"]);

/** Node's words for a TLS hello a server cut short: it speaks none. */
const NO_TLS_MESSAGE = "before secure TLS connection was established";

/** Every error code along an error's causes, the outermost first. */
function codesOf(error: unknown): string[] {
  const codes: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current; depth += 1) {
    if (typeof current !== "object") break;
    if ("code" in current && typeof current.code === "string") {
      codes.push(
        current instanceof Error && current.message.includes(NO_TLS_MESSAGE)
          ? "ERR_SSL_UNEXPECTED_EOF_WHILE_READING"
          : current.code,
      );
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return codes;
}

/**
 * The failure of a connection, told from the system's error codes along
 * the error's causes: an untrusted certificate, a server without TLS, a
 * host that does not answer. Null when it is none of them.
 */
export function connectionError(error: unknown): AppError | null {
  if (error instanceof AppError) return error;
  for (const code of codesOf(error)) {
    if (TLS_CODES.has(code) || code.startsWith("ERR_TLS")) {
      return new AppError("source_tls_failed", code, { cause: error });
    }
    if (NO_TLS_CODES.has(code)) {
      return new AppError("source_tls_unavailable", { cause: error });
    }
    if (TIMEOUT_CODES.has(code)) {
      return new AppError("source_timeout", { cause: error });
    }
    if (NETWORK_CODES.has(code))
      return new AppError("source_unreachable", code, { cause: error });
  }
  return null;
}
