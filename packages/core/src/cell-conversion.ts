import {
  assertCellValue,
  type CellColumn,
  type CellValue,
  readCellValue,
} from "./cell-values";
import { numberToDecimal, toDecimalString } from "./decimal";
import { selectOptionNames } from "./field-config";
import type { FieldType, WritableType } from "./field-types";
import { isIsoDateTime } from "./iso-date";
import { readNumberText } from "./typed-text";

/**
 * What a stored value becomes in a field of another type. There is one
 * rule, the cell's own: a value its write check takes is kept as it is, a
 * text is read as a cell reads it, and what neither takes does not fit.
 */

/** A stored value as a conversion reads it from the database. */
export type StoredCell = string | boolean | readonly string[];

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

/**
 * How a value becomes one of a field's type, the type's own rules: a
 * number is compared as the decimal it is; a text its write check takes
 * stays as it stands; a text it does not is read as the type reads one
 * (as a cell reads it, unless said); a list (options, people, files) is
 * read as its names joined, unless said; and what the trail holds comes
 * back as the type takes it (a boolean read, anything else as a text
 * converted, unless said).
 */
type Conversion = {
  number?: true;
  keepsText?: true;
  fromText?: (
    column: CellColumn,
    text: string,
    from: FieldType,
    timeZone: string | undefined,
  ) => CellValue | undefined;
  fromList?: (
    column: CellColumn,
    list: readonly string[],
  ) => CellValue | undefined;
  restore?: (column: CellColumn, held: HeldCell) => CellValue | undefined;
};

/** A value the trail holds for a row in the trash. */
type HeldCell = string | boolean | readonly string[];

const kept = (held: HeldCell): string => spelled(held);

/** One entry per writable type: `satisfies Record<…>` refuses a gap. */
const CONVERSIONS = {
  text: { keepsText: true, restore: (_column, held) => kept(held) },
  long_text: { keepsText: true, restore: (_column, held) => kept(held) },
  number: { number: true, keepsText: true },
  boolean: {
    fromText: (column, text, from) =>
      conversionOf(from).number ? text !== "0" : read(column, text),
  },
  date: {
    keepsText: true,
    // A held instant has no one day without a zone: it is not guessed.
    restore: (column, held) =>
      typeof held === "string" && isIsoDateTime(held.trim())
        ? undefined
        : convertCell("text", column, spelled(held)),
  },
  datetime: {
    keepsText: true,
    fromText: (column, text, _from, timeZone) =>
      toInstant(column, text, timeZone),
  },
  single_select: {
    keepsText: true,
    // A list is one option of it, or does not fit.
    fromList: (column, list) => {
      const [only] = list;
      return list.length === 1 && only !== undefined
        ? (optionNamed(column, only) ?? undefined)
        : undefined;
    },
    restore: (_column, held) => kept(held),
  },
  multi_select: {
    fromText: (column, text, from) => toList(from, column, text),
    restore: (_column, held) => [...heldList(held)],
  },
  email: { keepsText: true },
  url: { keepsText: true },
  phone: { keepsText: true },
  color: { keepsText: true },
  place: { keepsText: true },
  json: {},
  rating: { number: true, fromText: (column, text) => toFloat(column, text) },
  duration: {
    number: true,
    fromText: (column, text) => toFloat(column, text),
  },
  user: {
    restore: (_column, held) =>
      isList(held) && held.every((id) => UUID.test(id)) ? [...held] : undefined,
  },
  attachment: {
    restore: (_column, held) => (isList(held) ? [...held] : undefined),
  },
} satisfies Record<WritableType, Conversion>;

/** A link to one row comes back as the row's id, or not at all. */
const LINK: Conversion = {
  restore: (_column, held) =>
    typeof held === "string" && UUID.test(held) ? held : undefined,
};

function conversionOf(type: FieldType): Conversion {
  if (type === "relation_one_to_many") return LINK;
  return Object.hasOwn(CONVERSIONS, type)
    ? CONVERSIONS[type as WritableType]
    : {};
}

function fromText(
  from: FieldType,
  column: CellColumn,
  text: string,
  timeZone: string | undefined,
): CellValue | undefined {
  const conversion = conversionOf(column.fieldType);
  if (conversion.keepsText && takes(column, text)) return text;
  if (text.trim() === "") return null;
  return conversion.fromText
    ? conversion.fromText(column, text, from, timeZone)
    : read(column, text);
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
  const { fromList } = conversionOf(column.fieldType);
  return fromList
    ? fromList(column, stored)
    : fromText(from, column, stored.join(", "), timeZone);
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
    (conversionOf(to).number ? (toDecimalString(after) ?? after) : after) !==
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
  held: HeldCell,
): CellValue | undefined {
  const { restore } = conversionOf(column.fieldType);
  if (restore) return restore(column, held);
  return typeof held === "boolean"
    ? read(column, held)
    : convertCell("text", column, spelled(held));
}
