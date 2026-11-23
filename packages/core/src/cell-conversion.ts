import {
  assertCellValue,
  type CellColumn,
  type CellValue,
  readCellValue,
} from "./cell-values";
import { numberToDecimal, toDecimalString } from "./decimal";
import { selectOptionNames } from "./field-config";
import type { FieldType } from "./field-types";
import { isIsoDateTime } from "./iso-date";
import { readNumberText } from "./typed-text";

/**
 * What a stored value becomes in a field of another type. There is one
 * rule, the cell's own: a value its write check takes is kept as it is, a
 * text is read as a cell reads it, and what neither takes does not fit.
 */

/** A stored value as a conversion reads it from the database. */
export type StoredCell = string | boolean | readonly string[];

const NUMBERS: ReadonlySet<FieldType> = new Set([
  "number",
  "rating",
  "duration",
]);

/** The fields whose write check is asked of a text as it stands. */
const TAKES_TEXT: ReadonlySet<FieldType> = new Set([
  "text",
  "long_text",
  "email",
  "url",
  "phone",
  "color",
  "place",
  "number",
  "date",
  "datetime",
  "single_select",
]);

/** Two zones no offset makes agree: a time without one reads differently. */
const FAR_ZONES = ["Etc/GMT+12", "Pacific/Kiritimati"] as const;

function takes(column: CellColumn, value: unknown): boolean {
  try {
    assertCellValue(column, value);
    return true;
  } catch {
    return false;
  }
}

function read(
  column: CellColumn,
  raw: unknown,
  timeZone?: string,
): CellValue | undefined {
  const reading = readCellValue(
    column,
    raw,
    timeZone === undefined ? {} : { timeZone },
  );
  return "value" in reading ? reading.value : undefined;
}

/** An option named by a whole text, in its own case. */
function optionNamed(column: CellColumn, text: string): string | undefined {
  const names = selectOptionNames(column.config);
  const wanted = text.trim();
  return (
    names.find((name) => name === wanted) ??
    names.find((name) => name.toLowerCase() === wanted.toLowerCase())
  );
}

function toList(
  from: FieldType,
  column: CellColumn,
  text: string,
): CellValue | undefined {
  const whole = optionNamed(column, text);
  if (whole !== undefined) return [whole];
  // A single select's value is one option, whatever it holds.
  return from === "single_select" ? undefined : read(column, text);
}

/** A rating or a duration, kept only if it reads back as what was written. */
function toFloat(column: CellColumn, text: string): CellValue | undefined {
  const value = read(column, text);
  if (typeof value !== "number") return value;
  const written = readNumberText(text);
  return written === undefined || written === numberToDecimal(value)
    ? value
    : undefined;
}

/**
 * An instant from a text: its own offset, else the field's zone, else the
 * zone given. Without any, a time that depends on the zone is not guessed.
 */
function toInstant(
  column: CellColumn,
  text: string,
  timeZone: string | undefined,
): CellValue | undefined {
  const own = (column.config as { date?: { timeZone?: string } }).date
    ?.timeZone;
  if (timeZone !== undefined || own !== undefined) {
    return read(column, text, timeZone);
  }
  const [west, east] = FAR_ZONES.map((zone) => read(column, text, zone));
  return west === east ? west : undefined;
}

function fromText(
  from: FieldType,
  column: CellColumn,
  text: string,
  timeZone: string | undefined,
): CellValue | undefined {
  const { fieldType } = column;
  if (TAKES_TEXT.has(fieldType) && takes(column, text)) return text;
  if (text.trim() === "") return null;
  switch (fieldType) {
    case "boolean":
      return NUMBERS.has(from) ? text !== "0" : read(column, text);
    case "multi_select":
      return toList(from, column, text);
    case "rating":
    case "duration":
      return toFloat(column, text);
    case "datetime":
      return toInstant(column, text, timeZone);
    default:
      return read(column, text);
  }
}

/**
 * The value `stored`, of a field of type `from`, takes in `column`: `null`
 * when it holds nothing, `undefined` when it does not fit.
 */
export function convertCell(
  from: FieldType,
  column: CellColumn,
  stored: StoredCell,
  timeZone?: string,
): CellValue | undefined {
  if (typeof stored === "boolean") return read(column, stored);
  if (typeof stored === "string") {
    return fromText(from, column, stored, timeZone);
  }
  if (stored.length === 0) return null;
  if (column.fieldType === "single_select") {
    const [only] = stored;
    return stored.length === 1 && only !== undefined
      ? (optionNamed(column, only) ?? undefined)
      : undefined;
  }
  return fromText(from, column, stored.join(", "), timeZone);
}

function isList(value: unknown): value is readonly string[] {
  return Array.isArray(value);
}

function spelled(value: CellValue | StoredCell): string {
  return isList(value) ? value.join(", ") : String(value);
}

/**
 * Whether a conversion writes a value differently from how it was read,
 * or empties it. Numbers are compared as the decimals they are.
 */
export function conversionChanges(
  stored: StoredCell,
  kept: CellValue | undefined,
  to: FieldType,
): boolean {
  if (kept === undefined) return true;
  if (kept === null) return false;
  const after = spelled(kept);
  return (
    (NUMBERS.has(to) ? (toDecimalString(after) ?? after) : after) !==
    spelled(stored)
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function heldList(
  held: string | boolean | readonly string[],
): readonly string[] {
  return isList(held) ? held : [String(held)];
}

/**
 * A value of a row in the trash, as the trail holds it, in the field as it
 * is now. The field may have been converted since: what no longer fits
 * does not come back. A text keeps its length and a list its names, even
 * ones its options lost since: nothing is taken from a row that can come
 * back whole. An instant has no one day without a zone, and is not guessed.
 */
export function restoredCell(
  column: CellColumn,
  held: string | boolean | readonly string[],
): CellValue | undefined {
  switch (column.fieldType) {
    case "text":
    case "long_text":
    case "single_select":
      return spelled(held);
    case "multi_select":
      return [...heldList(held)];
    case "attachment":
      return isList(held) ? [...held] : undefined;
    case "user":
      return isList(held) && held.every((id) => UUID.test(id))
        ? [...held]
        : undefined;
    case "relation_one_to_many":
      return typeof held === "string" && UUID.test(held) ? held : undefined;
    case "date":
      return typeof held === "string" && isIsoDateTime(held.trim())
        ? undefined
        : convertCell("text", column, spelled(held));
    default:
      return typeof held === "boolean"
        ? read(column, held)
        : convertCell("text", column, spelled(held));
  }
}
