/**
 * Exact numbers (ADR 0023). A decimal or 64-bit value travels as a
 * canonical decimal string: an optional `-`, digits, and an optional `.`
 * followed by digits. No exponent, no grouping, no float on the way.
 */
import { trimEndRun } from "./plain-text";

const CANONICAL = /^-?\d+(?:\.\d+)?$/;
const SCIENTIFIC = /^([-+]?)(\d*)(?:\.(\d*))?[eE]([-+]?\d{1,4})$/;
const PLAIN = /^([-+]?)(\d*)(?:\.(\d*))?$/;

/** At most this many significant digits: PostgreSQL's numeric allows more. */
export const MAX_DECIMAL_DIGITS = 60;

export function isDecimalString(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_DECIMAL_DIGITS + 2 &&
    CANONICAL.test(value)
  );
}

/** `-0012.300` → `-12.3`; `0.0` → `0`. */
function canonical(sign: string, whole: string, fraction: string): string {
  const integer = whole.replace(/^0+(?=\d)/, "") || "0";
  const decimals = trimEndRun(fraction, "0");
  const body = decimals ? `${integer}.${decimals}` : integer;
  return sign === "-" && /[1-9]/.test(body) ? `-${body}` : body;
}

/**
 * The canonical form of a plain or scientific decimal, or undefined when
 * the text is not one. Scientific notation is expanded digit by digit, so
 * `1.5e3` is `1500` exactly.
 */
export function toDecimalString(text: string): string | undefined {
  const trimmed = text.trim();
  const scientific = SCIENTIFIC.exec(trimmed);
  if (scientific) {
    const [, sign = "", whole = "", fraction = "", exponent = "0"] = scientific;
    if (whole === "" && fraction === "") return undefined;
    const digits = `${whole}${fraction}`;
    const point = whole.length + Number(exponent);
    const padded =
      point <= 0
        ? `0.${"0".repeat(-point)}${digits}`
        : point >= digits.length
          ? `${digits}${"0".repeat(point - digits.length)}`
          : `${digits.slice(0, point)}.${digits.slice(point)}`;
    return toDecimalString(`${sign}${padded}`);
  }
  const plain = PLAIN.exec(trimmed);
  if (!plain) return undefined;
  const [, sign = "", whole = "", fraction = ""] = plain;
  if (whole === "" && fraction === "") return undefined;
  const result = canonical(sign, whole, fraction);
  return result.replace(/^-/, "").replace(".", "").length > MAX_DECIMAL_DIGITS
    ? undefined
    : result;
}

/**
 * A JavaScript number as a decimal. Only finite numbers; their shortest
 * round-trip text is the value the sender meant.
 */
export function numberToDecimal(value: number): string | undefined {
  return Number.isFinite(value) ? toDecimalString(String(value)) : undefined;
}

/** A decimal as a float, for drawing a chart or placing a pin, never for storing. */
export function decimalToNumber(value: unknown): number | undefined {
  if (typeof value === "number")
    return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** A decimal as an integer count of 10^-scale units. */
function scaled(value: string, scale: number): bigint {
  const negative = value.startsWith("-");
  const [whole = "0", fraction = ""] = value.replace(/^-/, "").split(".");
  const units = BigInt(`${whole}${fraction.padEnd(scale, "0")}`);
  return negative ? -units : units;
}

function unscaled(units: bigint, scale: number): string {
  const negative = units < 0n;
  const digits = (negative ? -units : units)
    .toString()
    .padStart(scale + 1, "0");
  const whole = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale);
  return canonical(negative ? "-" : "", whole, fraction);
}

function scaleOf(value: string): number {
  return value.split(".")[1]?.length ?? 0;
}

/**
 * The next `count` terms of the series that `last` ends and `step`
 * separates, exactly: dragging 1.1 and 1.2 down gives 1.3, 1.4, …
 */
export function decimalSeries(
  previous: string,
  last: string,
  count: number,
): string[] {
  const scale = Math.max(scaleOf(previous), scaleOf(last));
  const step = scaled(last, scale) - scaled(previous, scale);
  const start = scaled(last, scale);
  return Array.from({ length: count }, (_, index) =>
    unscaled(start + step * BigInt(index + 1), scale),
  );
}
