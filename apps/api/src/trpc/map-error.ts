import { AppError, publicError, type ErrorCode } from "@anygriddb/core";
import { TRPCError } from "@trpc/server";
import { logCause, uniqueViolation } from "../data/pg-error.js";

type TRPCCode = ConstructorParameters<typeof TRPCError>[0]["code"];

const TRPC_CODES: Partial<Record<number, TRPCCode>> = {
  400: "BAD_REQUEST",
  401: "UNAUTHORIZED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "CONFLICT",
  412: "PRECONDITION_FAILED",
  429: "TOO_MANY_REQUESTS",
};

/** Refusals worth a warning in the log: someone was stopped, nothing broke. */
const REFUSALS = new Set<ErrorCode>([
  "access_denied",
  "account_disabled",
  "signup_closed",
  "mfa_enrollment_required",
  "invalid_credentials",
  "invalid_code",
  "webauthn_rejected",
  "challenge_expired",
  "row_locked",
]);

/** The message of an error meant for people, or undefined for an internal one. */
export function publicErrorMessage(error: unknown): string | undefined {
  return error instanceof AppError ? error.message : undefined;
}

/** A public error as tRPC sends it; the error itself rides along as cause. */
export function toTRPCError(error: AppError): TRPCError {
  return new TRPCError({
    code: TRPC_CODES[error.status] ?? "BAD_REQUEST",
    message: error.message,
    cause: error,
  });
}

/**
 * What a tRPC client learns about a failure (ADR 0013): the public error's
 * code and detail, or a transport code when there is none.
 */
export function describeTRPCError(error: TRPCError) {
  if (error.cause instanceof AppError) return publicError(error.cause);
  const code: ErrorCode =
    error.code === "INTERNAL_SERVER_ERROR"
      ? "internal_error"
      : error.code === "BAD_REQUEST"
        ? "invalid_input"
        : error.code === "UNAUTHORIZED"
          ? "unauthenticated"
          : error.code === "NOT_FOUND"
            ? "not_found"
            : "request_rejected";
  return publicError(new AppError(code));
}

type ProcedureLog = {
  warn: (message: string) => void;
  error: (object: { err: unknown }, message: string) => void;
};

export function mapProcedureError(error: unknown, log: ProcedureLog): never {
  if (error instanceof TRPCError) throw error;
  if (error instanceof AppError) {
    if (REFUSALS.has(error.code)) log.warn(error.code.replaceAll("_", " "));
    throw toTRPCError(error);
  }
  const duplicate = uniqueViolation(error);
  if (duplicate) throw toTRPCError(duplicate);
  log.error({ err: logCause(error) }, "request failed");
  throw new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: "Internal error",
  });
}
