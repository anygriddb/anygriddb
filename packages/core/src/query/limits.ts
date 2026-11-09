/**
 * What a client's engine computes differently from AnyGridDB's exact
 * semantics (ADR 0005). A formula may use it anyway: the field says so,
 * in a sentence that names the engine, and the result is the engine's.
 * What no engine function can reproduce at all is still refused
 * (`function_unavailable`).
 *
 * - `approximate`: the engine computes the function in floating point,
 *   to about 15 significant digits, where PostgreSQL's is exact.
 * - `regex`: the engine chooses the first match a pattern allows where
 *   PostgreSQL chooses the longest (an alternative, a lazy quantifier).
 * - `precision`: the engine keeps at most 38 digits in a number, so a
 *   product or a quotient may be rounded (SQL Server keeps at least 6
 *   decimals). The compiler finds it from each operand's declared type
 *   (`digits.ts`): the formula editor, which knows no types, does not.
 */
import { formulaFunction, formulaTokens } from "../formula";
import type { DialectName } from "./dialect";

export type LimitCode = "approximate" | "precision" | "regex";

export type SourceLimit = {
  code: LimitCode;
  engine: DialectName;
  /** The function, as a formula writes it: `SQRT`. */
  fn?: string;
};

/** Functions in floating point everywhere but PostgreSQL. */
const FLOATING: ReadonlySet<string> = new Set([
  "sqrt",
  "exp",
  "ln",
  "log",
  "power",
  "std_dev",
  "variance",
  "std_dev_pop",
  "variance_pop",
]);

/**
 * Functions in floating point on one engine: MySQL reads a JSON number as
 * a double, so JSON_EXTRACT writes `1.50` as `1.5`, and past 15 digits
 * rounds it.
 */
const FLOATING_ON: Partial<Record<DialectName, ReadonlySet<string>>> = {
  mysql: new Set(["json_extract"]),
};

/** The limit `engine` puts on a function, or null when it is exact. */
export function limitOf(
  engine: DialectName,
  operation: string,
): SourceLimit | null {
  if (engine === "postgres") return null;
  if (!FLOATING.has(operation) && !FLOATING_ON[engine]?.has(operation)) {
    return null;
  }
  return { code: "approximate", engine, fn: operation.toUpperCase() };
}

/**
 * A pattern whose match the engine may choose otherwise: with an
 * alternative or a lazy quantifier, PostgreSQL takes the longest match,
 * MySQL and MariaDB the first that fits.
 */
export function regexLimit(
  engine: DialectName,
  fn: string,
): SourceLimit | null {
  return engine === "mysql" || engine === "mariadb"
    ? { code: "regex", engine, fn: fn.toUpperCase() }
    : null;
}

/** A number the engine may round, past its 38 digits. */
export function precisionLimit(engine: DialectName): SourceLimit {
  return { code: "precision", engine };
}

/** One entry per limit, whatever the operations that met it. */
export function limitKey(limit: SourceLimit): string {
  return `${limit.engine}:${limit.code}:${limit.fn ?? ""}`;
}

/**
 * The limits of `source` on `engine`, where each is written: the
 * formula editor marks them as the person types. The server finds the
 * same ones, and those of the fields the formula reads, when it compiles.
 */
export function formulaLimits(
  source: string,
  engine: DialectName,
): Array<SourceLimit & { from: number; to: number }> {
  if (engine === "postgres") return [];
  const found: Array<SourceLimit & { from: number; to: number }> = [];
  for (const token of formulaTokens(source)) {
    const text = source.slice(token.from, token.to);
    const operation =
      token.kind === "function" ? formulaFunction(text) : undefined;
    const limit = operation ? limitOf(engine, operation) : null;
    if (limit) found.push({ ...limit, from: token.from, to: token.to });
  }
  return found;
}
