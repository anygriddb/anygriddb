/**
 * Whether a cell still reads what its writer saw (ADR 0103).
 *
 * What a writer saw comes in two forms: as a read gave it, or as their own
 * last write sent it, which a page shows until it reads the row again. The
 * two differ where a field reads more than it is written with: a file reads
 * as its key, name and size, and is written as its key alone. Both sides are
 * therefore brought to what the field keeps before they are compared, so
 * that a person changing a cell twice in a row is not refused for the form
 * of their own write.
 */
import { canonicalDecimal, sameCell } from "./query/external-write";
import { compareCodeUnits } from "./text-order";
import { parseIsoInstant } from "./query/iso-instant";

/** Types that keep a text: only the same characters are the same value. */
const TEXT_TYPES: ReadonlySet<string> = new Set([
  "text",
  "long_text",
  "email",
  "url",
  "phone",
  "color",
  "place",
  "single_select",
]);

/** Past this exponent a number is compared as it is spelled. */
const MAX_EXPONENT = 1_000;

const JSON_NUMBER = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;

export function sameAsSeen(
  fieldType: string,
  current: unknown,
  seen: unknown,
): boolean {
  return sameFieldValue(
    fieldType,
    kept(fieldType, current),
    kept(fieldType, seen),
  );
}

/**
 * Two values of one field, compared as that field keeps them: a text to the
 * character, a number by value, an instant to the microsecond, a document
 * whatever the order of its keys and with every digit of its numbers. Empty
 * is only the same as empty.
 */
export function sameFieldValue(
  fieldType: string | undefined,
  left: unknown,
  right: unknown,
): boolean {
  if (
    left === null ||
    left === undefined ||
    right === null ||
    right === undefined
  ) {
    return (left ?? null) === (right ?? null);
  }
  if (fieldType !== undefined && TEXT_TYPES.has(fieldType)) {
    return textOf(left) === textOf(right);
  }
  if (fieldType === "json") return documentOf(left) === documentOf(right);
  if (fieldType === "date" || fieldType === "datetime") {
    const a = instantOf(left);
    const b = instantOf(right);
    if (a !== null && b !== null) return a === b;
  }
  return sameCell(left, right);
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** A cell as its field keeps it: an empty one is null, whatever said so. */
function kept(fieldType: string, value: unknown): unknown {
  if (value === undefined || value === null || value === "") return null;
  if (fieldType === "boolean") return value === true ? true : null;
  if (fieldType === "json") return value;
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    return value.map((item: unknown) =>
      fieldType === "attachment" ? fileKey(item) : String(item),
    );
  }
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return ordered(value);
  return value;
}

/** A file is its key: its name and size are read with it, not written. */
function fileKey(item: unknown): string {
  if (
    item !== null &&
    typeof item === "object" &&
    "key" in item &&
    typeof item.key === "string"
  ) {
    return item.key;
  }
  return String(item);
}

/**
 * A document in one spelling: its keys in order, each number by its exact
 * value and each string marked as one, so that `1` and `"1"` stay apart.
 * A text that is no document is compared as the text it is.
 */
function documentOf(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  try {
    return ordered(JSON.parse(text, exactValue));
  } catch {
    return `text:${text}`;
  }
}

function exactValue(
  _key: string,
  value: unknown,
  context?: { source?: string },
): unknown {
  if (typeof value === "string") return `s:${value}`;
  if (typeof value === "number") {
    return `n:${exactNumber(context?.source ?? String(value))}`;
  }
  return value;
}

/** A number's digits as they were written, `1e3` being `1000`. */
function exactNumber(source: string): string {
  const match = JSON_NUMBER.exec(source);
  if (!match) return source;
  const [, sign = "", whole = "", fraction = "", power = "0"] = match;
  const exponent = Number(power);
  if (Math.abs(exponent) > MAX_EXPONENT) return source.toLowerCase();
  const digits = `${whole}${fraction}`;
  const point = whole.length + exponent;
  const plain =
    point <= 0
      ? `0.${"0".repeat(-point)}${digits}`
      : point >= digits.length
        ? `${digits}${"0".repeat(point - digits.length)}`
        : `${digits.slice(0, point)}.${digits.slice(point)}`;
  return canonicalDecimal(`${sign}${plain}`);
}

/** The same document whatever order its keys were written in. */
function ordered(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => compareCodeUnits(a, b)),
        )
      : item,
  );
}

/** The moment a date or a date and time names, to the tenth of a microsecond. */
function instantOf(value: unknown): string | null {
  const text = value instanceof Date ? value.toISOString() : value;
  if (typeof text !== "string") return null;
  const parsed = parseIsoInstant(text, 1, 7);
  if (!parsed) return null;
  const [whole = "", fraction = ""] = parsed.timestamp.split(".");
  return `${whole}.${fraction.padEnd(7, "0")}`;
}
