/**
 * What a call out of the instance failed by, as a delivery keeps it: a
 * phrase the screens translate (`apps/web/lib/known-text.ts`), never the
 * error's own message, which may quote an address that is a secret. An
 * answer's status is kept as `HTTP <n>`.
 */
export const OUTBOUND_FAILURES = {
  blocked: "Blocked target",
  network: "Network error",
  timeout: "Timeout",
  tooLarge: "Answer too large",
  unknownHost: "Unknown host",
  refused: "Connection refused",
  tls: "TLS error",
  noMail: "Mail is not configured",
} as const;
