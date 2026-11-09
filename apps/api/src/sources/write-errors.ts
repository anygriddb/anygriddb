/**
 * What a client's database said when it refused a write, told plainly
 * (ADR 0006): a value it requires, a duplicate, a missing linked row, one
 * of its rules, a right the account lacks, a row another write holds.
 * Undefined for anything else: the read's mapping applies then.
 */
import { AppError, type ErrorCode } from "@anygriddb/core";
import { firstSqlServerError } from "./sqlserver.js";

type Mapped = { code: ErrorCode; detail?: string };

function field(error: unknown, name: string): string | undefined {
  if (!error || typeof error !== "object" || !(name in error)) return undefined;
  const value = (error as Record<string, unknown>)[name];
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : undefined;
}

/** A message the client's own rule raised: kept short, on one line. */
function said(error: unknown): string | undefined {
  const text = field(error, "message")?.replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 200) : undefined;
}

/** A name a message quotes: `column 'total'`, `"total"`. */
function quoted(
  message: string | undefined,
  after: RegExp,
): string | undefined {
  const match = message ? after.exec(message) : null;
  return match?.[1];
}

function postgres(error: unknown): Mapped | undefined {
  const code = field(error, "code");
  const column = field(error, "column");
  const constraint = field(error, "constraint");
  switch (code) {
    case "23502":
      return { code: "source_value_required", detail: column };
    case "23505":
      return { code: "source_value_duplicate", detail: constraint };
    // PostgreSQL 18 reports a RESTRICT key as 23001.
    case "23503":
    case "23001":
      return { code: "source_value_reference", detail: constraint };
    case "23514":
    case "23P01":
      return { code: "source_value_check", detail: constraint };
    case "22001":
      return { code: "source_value_too_long", detail: column };
    case "42501":
    case "25006":
      return { code: "source_write_denied" };
    case "55P03":
    case "40P01":
    case "40001":
      return { code: "source_row_busy" };
    case "P0001":
      return { code: "source_write_refused", detail: said(error) };
    default:
      // Data exceptions: a value the column's type does not take.
      return code?.startsWith("22")
        ? { code: "source_value_invalid" }
        : undefined;
  }
}

function mysql(error: unknown): Mapped | undefined {
  const number = Number(field(error, "errno"));
  const message = said(error);
  // "Column 'name' cannot be null", "Field 'name' doesn't have a default value"
  const column = quoted(message, /(?:column|field) '([^']+)'/i);
  switch (number) {
    case 1048:
    case 1364:
      return { code: "source_value_required", detail: column };
    case 1062:
    case 1586:
      return { code: "source_value_duplicate" };
    case 1451:
    case 1452:
      return { code: "source_value_reference" };
    case 3819:
      return {
        code: "source_value_check",
        detail: quoted(message, /constraint '([^']+)'/i),
      };
    case 1406:
      return { code: "source_value_too_long", detail: column };
    case 1264:
    case 1265:
    case 1292:
    case 1366:
    case 1367:
      return { code: "source_value_invalid", detail: column };
    case 1142:
    case 1143:
    case 1044:
    case 1792:
      return { code: "source_write_denied" };
    case 1205:
    case 1213:
      return { code: "source_row_busy" };
    case 1644:
      return { code: "source_write_refused", detail: message };
    default:
      return undefined;
  }
}

function sqlServer(error: unknown): Mapped | undefined {
  const number = Number(field(error, "number"));
  const message = said(error);
  const column = quoted(message, /column '([^']+)'/i);
  if (number >= 50_000)
    return { code: "source_write_refused", detail: message };
  switch (number) {
    case 515:
      return { code: "source_value_required", detail: column };
    case 2627:
    case 2601:
      return { code: "source_value_duplicate" };
    case 547:
      // A foreign key and a check constraint share the number.
      return /FOREIGN KEY|REFERENCE/i.test(message ?? "")
        ? { code: "source_value_reference" }
        : {
            code: "source_value_check",
            detail: quoted(message, /constraint "([^"]+)"/i),
          };
    case 2628:
    case 8152:
      return { code: "source_value_too_long", detail: column };
    case 8115:
    case 245:
    case 241:
    case 242:
    case 220:
    case 244:
    case 248:
    case 8114:
    case 544:
      return { code: "source_value_invalid", detail: column };
    case 229:
    case 230:
    case 3906:
      return { code: "source_write_denied" };
    case 1222:
    case 1205:
      return { code: "source_row_busy" };
    case 3609:
      return { code: "source_write_refused", detail: message };
    default:
      return undefined;
  }
}

/** The person's message for a refused write, or undefined for another error. */
export function writeError(
  engine: "postgres" | "mysql" | "mariadb" | "sqlserver",
  error: unknown,
): AppError | undefined {
  if (error instanceof AppError) return error;
  const mapped =
    engine === "postgres"
      ? postgres(error)
      : engine === "sqlserver"
        ? sqlServer(firstSqlServerError(error))
        : mysql(error);
  if (!mapped) return undefined;
  return mapped.detail
    ? new AppError(mapped.code, mapped.detail, { cause: error })
    : new AppError(mapped.code, { cause: error });
}
