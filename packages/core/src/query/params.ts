import { COLUMN_NAME } from "../names";
import { AppError, type ErrorCode } from "../errors";

export type ParameterizedSql = {
  text: string;
  values: unknown[];
};

const IDENTIFIER_ERRORS = {
  column: "invalid_column",
  "column name": "invalid_column_name",
  "table name": "invalid_table_name",
  identifier: "invalid_identifier",
  "row id": "invalid_row_id",
} as const satisfies Record<string, ErrorCode>;

export function assertIdentifier(
  value: string,
  label: keyof typeof IDENTIFIER_ERRORS,
): void {
  if (!COLUMN_NAME.test(value) || value.length > 63) {
    throw new AppError(IDENTIFIER_ERRORS[label]);
  }
}

/** Quotes an identifier that `assertIdentifier` already accepted. */
export function quoteIdent(value: string): string {
  assertIdentifier(value, "identifier");
  return `"${value}"`;
}

/**
 * A name from a client's database, quoted as SQL does: any text, with its
 * double quotes doubled. Control characters, which no sane name holds,
 * are refused.
 */
export function quoteExternalIdent(value: string): string {
  if (value.length === 0 || value.length > 128 || /\p{Cc}/u.test(value)) {
    throw new AppError("invalid_identifier");
  }
  return `"${value.replaceAll('"', '""')}"`;
}

/** Collects bound values and hands out `$n` placeholders in order. */
export class SqlParams {
  readonly values: unknown[] = [];

  bind(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }

  /** Binds a JS array as a JSON document and expands it to a Postgres array. */
  bindTextArray(items: readonly string[]): string {
    return `array(select jsonb_array_elements_text(${this.bind(JSON.stringify(items))}::text::jsonb))`;
  }
}
