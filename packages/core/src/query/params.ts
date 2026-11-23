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

/**
 * Rewrites each `$n` of a statement, outside quoted text and identifiers:
 * a JSON path such as `'$[0]'` is no placeholder. `count` is how many
 * values the statement binds.
 */
export function rewritePlaceholders(
  text: string,
  count: number,
  render: (position: number) => string,
): string {
  let output = "";
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? "";
    if (quote) {
      output += char;
      if (char === quote) {
        // A doubled quote stays inside the literal.
        if (text[index + 1] === quote) {
          output += quote;
          index += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      output += char;
      continue;
    }
    const placeholder =
      char === "$" ? /^\$(\d+)/.exec(text.slice(index)) : null;
    if (placeholder) {
      const position = Number(placeholder[1]);
      if (position < 1 || position > count) {
        throw new AppError("internal_error", "placeholder");
      }
      output += render(position);
      index += placeholder[0].length - 1;
      continue;
    }
    output += char;
  }
  return output;
}

/**
 * A statement with only the values it reads, numbered again in their
 * order. Compiling a formula binds each literal as it meets it, and may
 * then keep none of that argument's SQL: PostgreSQL cannot give a type to
 * a parameter nothing reads, and refuses the whole statement.
 */
export function withoutUnreadValues<Statement extends ParameterizedSql>(
  statement: Statement,
): Statement {
  const read = new Set<number>();
  rewritePlaceholders(statement.text, statement.values.length, (position) => {
    read.add(position);
    return "";
  });
  if (read.size === statement.values.length) return statement;
  const kept = [...read].sort((left, right) => left - right);
  const renumbered = new Map(kept.map((position, index) => [position, index]));
  return {
    ...statement,
    text: rewritePlaceholders(
      statement.text,
      statement.values.length,
      (position) => `$${String((renumbered.get(position) ?? 0) + 1)}`,
    ),
    values: kept.map((position) => statement.values[position - 1]),
  };
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
