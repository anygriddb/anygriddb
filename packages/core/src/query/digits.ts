/**
 * SQL Server's decimals, followed through a formula (ADR 0027). T-SQL
 * types every number `decimal(p, s)` with p at most 38, and decides the
 * type of a result from the types of its operands, not their values:
 * past 38 digits it cuts the scale, rounding, or keeps it and may
 * overflow. Knowing each operand's type, the compiler chooses casts that
 * keep AnyGridDB's results (a quotient to 20 decimals) and finds where the
 * engine's limit truly applies.
 */

/** A `decimal(p, s)`: p digits, s of them after the point. */
export type Digits = { readonly p: number; readonly s: number };

const MAX = 38;

/**
 * A number whose type the compiler did not follow: assumed as wide as
 * T-SQL allows, so any arithmetic on it is marked as possibly rounded,
 * never the reverse.
 */
export const UNKNOWN_DIGITS: Digits = { p: MAX, s: 18 };

/** `int`, `bigint`: whole numbers. */
export const INT_DIGITS: Digits = { p: 10, s: 0 };
export const BIGINT_DIGITS: Digits = { p: 19, s: 0 };

/** What a result reads as, and whether T-SQL kept it whole. */
export type Sized = { digits: Digits; exact: boolean };

function integral(digits: Digits): number {
  return digits.p - digits.s;
}

/**
 * The type T-SQL gives a product or a quotient that needs `whole` digits
 * before the point and `scale` after: past 38, the scale shrinks to keep
 * the whole part when it is under 32 digits, else to 6 (or less, if it
 * was less).
 */
function bounded(whole: number, scale: number): Sized {
  if (whole + scale <= MAX) {
    return { digits: { p: Math.max(whole + scale, 1), s: scale }, exact: true };
  }
  const s = whole < 32 ? Math.min(scale, MAX - whole) : Math.min(scale, 6);
  return { digits: { p: MAX, s }, exact: false };
}

/** `a + b` and `a - b`: T-SQL keeps the scale and narrows the whole part. */
export function sumDigits(a: Digits, b: Digits): Sized {
  const scale = Math.max(a.s, b.s);
  const whole = Math.max(integral(a), integral(b)) + 1;
  return whole + scale <= MAX
    ? { digits: { p: whole + scale, s: scale }, exact: true }
    : { digits: { p: MAX, s: scale }, exact: false };
}

export function productDigits(a: Digits, b: Digits): Sized {
  return bounded(integral(a) + integral(b) + 1, a.s + b.s);
}

export function quotientDigits(a: Digits, b: Digits): Sized {
  return bounded(integral(a) + b.s, Math.max(6, a.s + b.p + 1));
}

/** The type of a CASE or a VALUES column over several numbers. */
export function unionDigits(all: readonly Digits[]): Sized {
  const scale = Math.max(0, ...all.map((digits) => digits.s));
  const whole = Math.max(1, ...all.map(integral));
  return whole + scale <= MAX
    ? { digits: { p: whole + scale, s: scale }, exact: true }
    : { digits: { p: MAX, s: Math.max(0, MAX - whole) }, exact: false };
}

/** Whether a result's whole part may outgrow its type: T-SQL then fails. */
export function mayOverflow(a: Digits, b: Digits, op: "mul" | "div"): boolean {
  const whole =
    op === "mul" ? integral(a) + integral(b) + 1 : integral(a) + b.s;
  return whole > 32;
}

/**
 * The cast that makes `a / b` exact to 20 decimals, when the types allow
 * it: the dividend widened to 20 decimals or more, the quotient's whole
 * part small enough that T-SQL keeps 21 decimals. T-SQL truncates a
 * quotient at its scale, so 21 kept decimals round to 20 exactly.
 */
export function exactDividend(a: Digits, b: Digits): Digits | null {
  const scale = Math.max(a.s, 20);
  const whole = integral(a);
  if (whole + b.s > 17 || whole + scale > MAX) return null;
  return { p: whole + scale, s: scale };
}

/** The digits of a SQL Server column type: `decimal(14,2)`, `int`, `money`. */
export function columnDigits(type: string): Digits {
  const lower = type.trim().toLowerCase();
  const sized = /^(?:decimal|numeric)\((\d+),\s*(\d+)\)$/.exec(lower);
  if (sized) return { p: Number(sized[1]), s: Number(sized[2]) };
  switch (lower.replace(/\(.*$/, "")) {
    case "tinyint":
      return { p: 3, s: 0 };
    case "smallint":
      return { p: 5, s: 0 };
    case "int":
      return INT_DIGITS;
    case "bigint":
      return BIGINT_DIGITS;
    case "money":
      return { p: 19, s: 4 };
    case "smallmoney":
      return { p: 10, s: 4 };
    // Read as decimal(38,10) (`readColumn`).
    case "float":
    case "real":
      return { p: MAX, s: 10 };
    default:
      return UNKNOWN_DIGITS;
  }
}

/** The digits of a decimal literal, as `numberLiteral` casts it. */
export function literalDigits(value: string): Digits {
  const [whole = "", fraction = ""] = value.replace(/^-/, "").split(".");
  const s = Math.min(fraction.length, MAX);
  const p = Math.min(Math.max(whole.replace(/^0+/, "").length + s, 1), MAX);
  return { p: Math.max(p, s), s };
}
