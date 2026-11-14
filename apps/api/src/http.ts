import {
  AppError,
  publicError,
  type ErrorCode,
  type PublicError,
} from "@anygriddb/core";

type HeaderReply = {
  header: (name: string, value: string) => void;
};

type FailureLog = {
  error: (object: Record<string, unknown>, message: string) => void;
  info: (object: Record<string, unknown>, message: string) => void;
};

/**
 * A failed request in the log: a fault of the server (5xx) as an error,
 * with its stack; a refused request (4xx: a rate limit, a bad input, a
 * missing right) on one info line, so a client hammering a limit does not
 * flood the errors an operator alerts on.
 */
export function logFailure(
  log: FailureLog,
  failure: {
    error: unknown;
    status: number;
    message: string;
    context?: Record<string, unknown>;
  },
): void {
  if (failure.status >= 500) {
    log.error({ ...failure.context, err: failure.error }, failure.message);
    return;
  }
  log.info({ ...failure.context, status: failure.status }, failure.message);
}

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

/**
 * HTTP status and public body for any thrown value on a Fastify route:
 * AppError keeps its code; Fastify 4xx keep their status; everything else
 * is an internal error.
 */
export function replyFromError(error: unknown): {
  status: number;
  body: ReturnType<typeof publicErrorBody>;
} {
  if (error instanceof AppError) {
    return { status: error.status, body: errorBody(publicError(error)) };
  }
  const statusCode =
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    typeof error.statusCode === "number"
      ? error.statusCode
      : undefined;
  const status = publicErrorStatus(statusCode);
  return { status, body: publicErrorBody(status) };
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
function errorBody(failure: PublicError): {
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
