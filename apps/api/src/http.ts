import {
  AppError,
  publicError,
  type ErrorCode,
  type PublicError,
} from "@anygriddb/core";

type HeaderReply = {
  header: (name: string, value: string) => void;
};

/** Removes line breaks so a user value cannot forge extra log lines. */
export function stripCrlf(value: string): string {
  return value.replace(/[\r\n\u2028\u2029]/g, "");
}

export function applyApiSecurityHeaders(
  reply: HeaderReply,
  hsts: boolean,
): void {
  reply.header(
    "Content-Security-Policy",
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  );
  reply.header("X-Frame-Options", "DENY");
  reply.header("X-Content-Type-Options", "nosniff");
  if (hsts) {
    reply.header(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains",
    );
  }
}

export function publicErrorStatus(statusCode: number | undefined): number {
  if (typeof statusCode === "number" && statusCode >= 400 && statusCode < 500) {
    return statusCode;
  }
  return 500;
}

function codeFor(status: number): ErrorCode {
  if (status >= 500) return "internal_error";
  if (status === 401) return "unauthenticated";
  if (status === 403) return "access_denied";
  if (status === 404) return "not_found";
  if (status === 413) return "file_too_large";
  return "request_rejected";
}

/** A failure as every HTTP route sends it (ADR 0013). */
export function errorBody(failure: PublicError): {
  error: string;
  code: ErrorCode;
  detail?: string;
} {
  return {
    error: failure.message,
    code: failure.code,
    ...(failure.detail === undefined ? {} : { detail: failure.detail }),
  };
}

/** A refusal with a status, and a code when one says more than the status. */
export function publicErrorBody(status: number, code?: ErrorCode) {
  return errorBody(publicError(new AppError(code ?? codeFor(status))));
}
