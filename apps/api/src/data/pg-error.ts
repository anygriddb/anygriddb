import { AppError } from "@anygriddb/core";

/**
 * A foreign key refused the change: `23503`, or `23001` from PostgreSQL 18
 * on for an ON DELETE / ON UPDATE RESTRICT key.
 */
export function isForeignKeyViolation(error: unknown): boolean {
  const code = postgresCode(error);
  return code === "23503" || code === "23001";
}

export function postgresCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  if ("code" in error && typeof error.code === "string") {
    return error.code;
  }
  if ("cause" in error) {
    return postgresCode(error.cause);
  }
  return undefined;
}

function errorText(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if ("message" in current && typeof current.message === "string") {
      parts.push(current.message);
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return parts.join("\n");
}

function constraintName(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  if ("constraint" in error && typeof error.constraint === "string") {
    return error.constraint;
  }
  if ("cause" in error) return constraintName(error.cause);
  return undefined;
}

/**
 * A unique violation as a public error. The constraint name only: the
 * conflicting value stays out of the client and the log.
 */
export function uniqueViolation(error: unknown): AppError | null {
  if (postgresCode(error) !== "23505") return null;
  return new AppError("duplicate_values", constraintName(error));
}

/** What a log may keep of an error. A unique violation keeps no row value. */
export function logCause(error: unknown): unknown {
  const duplicate = uniqueViolation(error);
  if (duplicate) {
    return { code: "23505", constraint: duplicate.detail };
  }
  return error;
}

/** Maps trigger failures to the stable messages the HTTP layer already knows. */
export function rethrowAuditError(error: unknown): never {
  // A unique violation goes on as PostgreSQL raised it: each caller names
  // its own (a table, a source, an account that already exists). The one
  // nobody named becomes a public error where the request ends.
  if (postgresCode(error) === "23505") {
    throw error;
  }
  const text = errorText(error);
  if (text.includes("Row locked")) {
    throw new AppError("row_locked", { cause: error });
  }
  if (text.includes("Invalid status")) {
    throw new AppError("invalid_status", { cause: error });
  }
  if (text.includes("Audit context required")) {
    throw new Error("Audit context required", { cause: error });
  }
  if (text.includes("Audit immutable")) {
    throw new Error("Audit immutable", { cause: error });
  }
  throw error;
}
