import { AppError, OUTBOUND_FAILURES } from "@anygriddb/core";

const BODY_SHOWN = 2_048;

/** Strings long enough to be a credential, wherever they sit in a value. */
export function secretStrings(value: unknown): string[] {
  if (typeof value === "string") return value.length >= 8 ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(secretStrings);
  if (value !== null && typeof value === "object") {
    return Object.values(value).flatMap(secretStrings);
  }
  return [];
}

/** Replaces credential text before a response is shown or stored. */
export function redactSecrets(
  text: string,
  secrets: readonly string[],
): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length < 8) continue;
    out = out.split(secret).join("••••");
  }
  return out.slice(0, BODY_SHOWN);
}

/**
 * A failure an administrator can read. The message of an unknown error
 * is not used: it often quotes the address, and some addresses are secrets.
 */
export function outboundFailureText(error: unknown): string {
  const said = OUTBOUND_FAILURES;
  if (error instanceof AppError && error.code === "invalid_outbound_target") {
    return said.blocked;
  }
  if (!(error instanceof Error)) return said.network;
  if (error.message === "Timeout") return said.timeout;
  if (error.message === "Answer too large") return said.tooLarge;
  if (/^HTTP \d{3}$/.test(error.message)) return error.message;
  const code = (error as { code?: unknown }).code;
  if (code === "EBLOCKED") return said.blocked;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return said.unknownHost;
  if (code === "ECONNREFUSED") return said.refused;
  if (
    code === "CERT_HAS_EXPIRED" ||
    code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
    code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
    (typeof code === "string" && code.startsWith("ERR_TLS"))
  ) {
    return said.tls;
  }
  return said.network;
}
