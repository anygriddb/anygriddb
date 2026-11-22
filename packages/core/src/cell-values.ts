import { z } from "zod";
import { isDecimalString, numberToDecimal } from "./decimal";
import {
  isTimeZone,
  selectOptionNames,
  type ColumnConfig,
} from "./field-config";
import {
  isComputedType,
  isRelationType,
  isSystemType,
  type FieldType,
} from "./field-types";
import { AppError } from "./errors";
import { isIsoDate, isIsoDateTime } from "./iso-date";
import { isJsonDocument, parseJsonDocument } from "./json-text";
import {
  type DayOrder,
  type DecimalMark,
  DURATION_WITH_DAYS,
  isAmbiguousDate,
  isAmbiguousNumber,
  isAmbiguousPoint,
  readDayText,
  readInstantText,
  readNumberText,
} from "./typed-text";

export const ATTACHMENT_KEY = /^att[A-Za-z0-9_-]{20,80}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PHONE = /^\+?[0-9 ().-]{3,32}$/;

/**
 * A colour as it is kept: `#rrggbb`, in lower case. One spelling, so that
 * two cells of the same colour are equal to a filter and to a group.
 */
const COLOR = /^#[0-9a-f]{6}$/;
const COLOR_TYPED = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

export function isColor(value: string): boolean {
  return COLOR.test(value);
}

/** `#abc`, `ABCDEF`, `#AbCdEf`: the colour as it is kept, or nothing. */
export function parseColor(text: string): string | undefined {
  const hex = COLOR_TYPED.exec(text.trim())?.[1]?.toLowerCase();
  if (hex === undefined) return undefined;
  // Three digits stand for six: each one twice.
  return hex.length === 3 ? `#${hex.replace(/./g, "$&$&")}` : `#${hex}`;
}

/** Decimal degrees keep six decimals: a tenth of a metre. */
const PLACE_DECIMALS = 6;
/** What a person types for a place is short: anything longer is no place. */
const PLACE_MAX_CHARS = 64;
// Read once every run of spaces is one space, so that no part of either
// pattern can take the same characters as its neighbour: a long run of
// spaces is then read once, not once per way of sharing it out.
/** Decimal points; a comma, a semicolon or a space between the two. */
const PLACE_POINTS =
  /^([+-]?\d{1,3}(?:\.\d+)?) ?[,; ] ?([+-]?\d{1,3}(?:\.\d+)?)$/;
/** Decimal commas: the comma is taken, so a semicolon or a space between. */
const PLACE_COMMAS = /^([+-]?\d{1,3}(?:,\d+)?) ?[; ] ?([+-]?\d{1,3}(?:,\d+)?)$/;

export type Place = { latitude: number; longitude: number };

function degrees(value: number): string {
  // No trailing zeros, and no exponent at this size: 48.8566, not 48.856600.
  return String(Number(value.toFixed(PLACE_DECIMALS)));
}

/**
 * A place as it is kept: `latitude,longitude` in decimal degrees (WGS 84),
 * six decimals at most, no space. Latitude within 90 degrees of the
 * equator, longitude within 180 of Greenwich; nothing for anything else.
 */
export function formatPlace(place: Place): string | undefined {
  const { latitude, longitude } = place;
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180
  ) {
    return undefined;
  }
  return `${degrees(latitude)},${degrees(longitude)}`;
}

/**
 * Reads what a person types or pastes: the latitude, then the longitude
 * (`48.8566, 2.3522`, `48.8566 2.3522`, `48,8566; 2,3522`). Nothing for
 * anything else, a place off the globe included.
 */
export function parsePlace(text: string): Place | undefined {
  const typed = text.trim().replace(/\s+/g, " ");
  if (typed.length > PLACE_MAX_CHARS) return undefined;
  const match = PLACE_POINTS.exec(typed) ?? PLACE_COMMAS.exec(typed);
  if (!match) return undefined;
  const place = {
    latitude: Number(match[1]?.replace(",", ".")),
    longitude: Number(match[2]?.replace(",", ".")),
  };
  return formatPlace(place) === undefined ? undefined : place;
}

/** Whether a text is a place exactly as it is kept. */
export function isPlace(value: string): boolean {
  const place = parsePlace(value);
  return place !== undefined && formatPlace(place) === value;
}

const MAX_ARRAY_ITEMS = 100;

/** The most files one attachment cell holds. */
export const MAX_CELL_FILES = 20;

/** Wire shape of a cell. Arrays hold option names, user ids, or file keys. */
export const cellValueSchema = z.union([
  z.string().max(20_000),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.string().max(200)).max(MAX_ARRAY_ITEMS),
]);

export type CellValue = z.infer<typeof cellValueSchema>;

export type CellColumn = { fieldType: FieldType; config: ColumnConfig };

/** The most characters each kind of text field holds. */
export const CELL_TEXT_LIMITS = { text: 4_000, long_text: 20_000 } as const;

/** Past 2^53 a JSON integer has already been rounded: it is not what was sent. */
function isRoundedInteger(value: number): boolean {
  return Number.isInteger(value) && !Number.isSafeInteger(value);
}

export function isEmail(value: string): boolean {
  return value.length <= 254 && z.email().safeParse(value).success;
}

export function isHttpUrl(value: string): boolean {
  if (value.length > 2_000) {
    return false;
  }
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

function isUniqueStrings(value: unknown, max: number): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= max &&
    value.every((item) => typeof item === "string") &&
    new Set(value).size === value.length
  );
}

/**
 * Checks a value against its column before it reaches SQL. Throws a stable
 * message: `Formula column is computed`, `Column is read-only`,
 * `Invalid relation`, `Invalid attachment`, or `Invalid cell`.
 */
export function assertCellValue(column: CellColumn, value: unknown): void {
  const { fieldType, config } = column;
  if (isComputedType(fieldType)) {
    throw new AppError("formula_column_is_computed");
  }
  if (isSystemType(fieldType)) {
    throw new AppError("column_is_read_only");
  }
  if (isRelationType(fieldType)) {
    throw new AppError("invalid_relation");
  }
  if (value === null) {
    return;
  }
  switch (fieldType) {
    case "text":
      if (typeof value === "string" && value.length <= CELL_TEXT_LIMITS.text)
        return;
      break;
    case "long_text":
      if (
        typeof value === "string" &&
        value.length <= CELL_TEXT_LIMITS.long_text
      )
        return;
      break;
    case "email":
      if (typeof value === "string" && isEmail(value)) return;
      break;
    case "url":
      if (typeof value === "string" && isHttpUrl(value)) return;
      break;
    case "phone":
      if (typeof value === "string" && PHONE.test(value)) return;
      break;
    case "color":
      if (typeof value === "string" && isColor(value)) return;
      break;
    case "place":
      if (typeof value === "string" && isPlace(value)) return;
      break;
    case "json":
      if (isJsonDocument(value)) return;
      break;
    case "number": {
      // Exact as a decimal string (ADR 0023). A finite number is accepted
      // from older clients, unless it is an integer JSON has already rounded.
      const decimal = isDecimalString(value);
      if (
        !decimal &&
        !(
          typeof value === "number" &&
          Number.isFinite(value) &&
          !isRoundedInteger(value)
        )
      ) {
        break;
      }
      // Under zero: a minus sign before a digit that is not zero.
      const negative = decimal
        ? value.startsWith("-") && /[1-9]/.test(value)
        : value < 0;
      if (config.nonNegative && negative) {
        throw new AppError("negative_number");
      }
      return;
    }
    case "duration":
      if (typeof value === "number" && Number.isFinite(value) && value >= 0)
        return;
      break;
    case "rating": {
      const max = config.ratingMax ?? 5;
      if (
        typeof value === "number" &&
        Number.isInteger(value) &&
        value >= 0 &&
        value <= max
      )
        return;
      break;
    }
    case "boolean":
      if (typeof value === "boolean") return;
      break;
    case "date":
      if (typeof value === "string" && isIsoDate(value)) return;
      break;
    case "datetime":
      if (typeof value === "string" && isIsoDateTime(value)) return;
      break;
    case "single_select":
      if (
        typeof value === "string" &&
        selectOptionNames(config).includes(value)
      )
        return;
      break;
    case "multi_select": {
      const names = selectOptionNames(config);
      if (
        isUniqueStrings(value, MAX_ARRAY_ITEMS) &&
        value.every((item) => names.includes(item))
      )
        return;
      break;
    }
    case "user": {
      const max = config.multiple ? 50 : 1;
      if (isUniqueStrings(value, max) && value.every((id) => UUID.test(id)))
        return;
      break;
    }
    case "attachment":
      if (
        isUniqueStrings(value, MAX_CELL_FILES) &&
        value.every((key) => ATTACHMENT_KEY.test(key))
      )
        return;
      throw new AppError("invalid_attachment");
  }
  throw new AppError("invalid_cell");
}

const TRUE_WORDS = new Set([
  "true",
  "yes",
  "y",
  "1",
  "x",
  "✓",
  "✔",
  "oui",
  "vrai",
  "checked",
  "on",
]);
const FALSE_WORDS = new Set([
  "false",
  "no",
  "n",
  "0",
  "",
  "non",
  "faux",
  "unchecked",
  "off",
]);

function parseDuration(
  raw: string,
  mark: DecimalMark | undefined,
): number | undefined {
  const value = raw.trim().replace(/\s+/g, " ");
  const days = DURATION_WITH_DAYS.exec(value);
  if (days) {
    return (
      Number(days[1]) * 86_400 +
      Number(days[2]) * 3600 +
      Number(days[3]) * 60 +
      Number(days[4] ?? 0)
    );
  }
  const clock = /^(\d+):([0-5]\d)(?::([0-5]\d(?:\.\d+)?))?$/.exec(value);
  if (clock) {
    return (
      Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3] ?? 0)
    );
  }
  return readFloat(value, mark);
}

function readFloat(
  raw: string,
  mark: DecimalMark | undefined,
): number | undefined {
  const decimal = readNumberText(raw, mark);
  if (decimal === undefined) return undefined;
  const value = Number(decimal);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * The order a day in numbers is read in: the one its field declares (`us`,
 * `eu`), else the reader's. The other formats only say how a day is shown.
 */
function dayOrderOf(
  config: ColumnConfig,
  context: CoerceContext,
): DayOrder | undefined {
  const format = (config as { date?: { format?: string } }).date?.format;
  if (format === "us") return "month-first";
  if (format === "eu") return "day-first";
  return context.dayOrder;
}

/** Zones already asked about: checking one builds a formatter. */
const KNOWN_ZONES = new Map<string, boolean>();

function isUsableZone(zone: string): boolean {
  let known = KNOWN_ZONES.get(zone);
  if (known === undefined) {
    known = isTimeZone(zone);
    if (KNOWN_ZONES.size >= 512) KNOWN_ZONES.clear();
    KNOWN_ZONES.set(zone, known);
  }
  return known;
}

/** The zone a date and time field keeps: its own, else the reader's, else UTC. */
function fieldZone(config: ColumnConfig, context: CoerceContext): string {
  const own = (config as { date?: { timeZone?: string } }).date?.timeZone;
  if (own && isUsableZone(own)) return own;
  return context.timeZone && isUsableZone(context.timeZone)
    ? context.timeZone
    : "UTC";
}

function splitList(raw: string): string[] {
  return raw
    .split(/[,;\n]/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

type CoerceContext = {
  /** Resolves a pasted user name or email to a user id. */
  resolveUser?: (text: string) => string | undefined;
  /**
   * The decimal mark of the text read: the reader's language, or what an
   * import was told. Without it, a number that reads two ways is refused.
   */
  decimalMark?: DecimalMark;
  /**
   * Which comes first in a day in numbers, where the reader's language or
   * an import says so. Without it, and without a format on the field, a
   * day that reads two ways is refused.
   */
  dayOrder?: DayOrder;
  /** Where a day alone starts, for a field with no zone of its own. */
  timeZone?: string;
};

/** Why a value was not taken, for whoever reports it. */
export type CellRefusal =
  | { code: "value_too_long"; limit: number }
  | { code: "ambiguous_number" }
  | { code: "ambiguous_point" }
  | { code: "ambiguous_date" }
  | { code: "invalid_cell" };

type CellReading = { value: CellValue } | { refused: CellRefusal };

function refusalOf(
  column: CellColumn,
  raw: unknown,
  candidate: CellValue | undefined,
  context: CoerceContext,
): CellRefusal {
  const { fieldType } = column;
  if (
    (fieldType === "text" || fieldType === "long_text") &&
    typeof candidate === "string" &&
    candidate.length > CELL_TEXT_LIMITS[fieldType]
  ) {
    return { code: "value_too_long", limit: CELL_TEXT_LIMITS[fieldType] };
  }
  if (typeof raw !== "string") return { code: "invalid_cell" };
  if (
    fieldType === "number" ||
    fieldType === "rating" ||
    fieldType === "duration"
  ) {
    if (context.decimalMark === undefined && isAmbiguousNumber(raw)) {
      return { code: "ambiguous_number" };
    }
    if (context.decimalMark === "," && isAmbiguousPoint(raw)) {
      return { code: "ambiguous_point" };
    }
  }
  if (
    (fieldType === "date" || fieldType === "datetime") &&
    dayOrderOf(column.config, context) === undefined &&
    isAmbiguousDate(raw)
  ) {
    return { code: "ambiguous_date" };
  }
  return { code: "invalid_cell" };
}

/**
 * Reads loose input (pasted text, a file's cells, API `typecast`) as the
 * value its column keeps, by the language and format declared, or says
 * why not: nothing is cut, rounded, or completed to fit. Never throws.
 */
export function readCellValue(
  column: CellColumn,
  raw: unknown,
  context: CoerceContext = {},
): CellReading {
  const candidate = coerceRaw(column, raw, context);
  if (candidate === undefined) {
    return { refused: refusalOf(column, raw, candidate, context) };
  }
  try {
    assertCellValue(column, candidate);
    return { value: candidate };
  } catch {
    return { refused: refusalOf(column, raw, candidate, context) };
  }
}

/** `readCellValue`'s value, or `undefined` when it was refused. */
export function coerceCellValue(
  column: CellColumn,
  raw: unknown,
  context: CoerceContext = {},
): CellValue | undefined {
  const reading = readCellValue(column, raw, context);
  return "value" in reading ? reading.value : undefined;
}

function coerceRaw(
  column: CellColumn,
  raw: unknown,
  context: CoerceContext,
): CellValue | undefined {
  if (raw === null || raw === undefined) {
    return null;
  }
  const { fieldType, config } = column;
  if (typeof raw === "number" && isRoundedInteger(raw)) {
    return undefined;
  }
  if (Array.isArray(raw)) {
    if (raw.some((item) => typeof item === "number" && isRoundedInteger(item)))
      return undefined;
    // A list sent as such is the document itself.
    if (fieldType === "json") {
      return parseJsonDocument(JSON.stringify(raw));
    }
    if (
      fieldType === "multi_select" ||
      fieldType === "user" ||
      fieldType === "attachment"
    ) {
      const items = raw.flatMap((item) =>
        typeof item === "string" ? [item.trim()] : [],
      );
      return coerceRaw(column, items.join(","), context);
    }
    return coerceRaw(column, raw.map(String).join(", "), context);
  }
  if (typeof raw === "number" || typeof raw === "boolean") {
    if (fieldType === "number") {
      return typeof raw === "number" ? numberToDecimal(raw) : raw ? "1" : "0";
    }
    if (fieldType === "rating" || fieldType === "duration") {
      return typeof raw === "number" ? raw : raw ? 1 : 0;
    }
    if (fieldType === "boolean") {
      return typeof raw === "boolean" ? raw : raw !== 0;
    }
    return coerceRaw(column, String(raw), context);
  }
  if (typeof raw !== "string") {
    return undefined;
  }
  const text = raw.replace(/\r\n/g, "\n");
  const trimmed = text.trim();
  if (trimmed === "" && fieldType !== "boolean") {
    return null;
  }
  switch (fieldType) {
    case "text":
      return text.replace(/\n/g, " ");
    case "long_text":
      return text;
    case "email":
    case "url":
    case "phone":
      return trimmed;
    case "color":
      return parseColor(trimmed);
    case "place": {
      const place = parsePlace(trimmed);
      return place ? formatPlace(place) : undefined;
    }
    case "json":
      return parseJsonDocument(trimmed);
    case "number":
      return readNumberText(trimmed, context.decimalMark);
    case "rating":
      // Only stars, or a number: a whole one, which the check asks.
      return /^[★⭐]+$/u.test(trimmed)
        ? (trimmed.match(/[★⭐]/gu)?.length ?? 0)
        : readFloat(trimmed, context.decimalMark);
    case "duration":
      return parseDuration(trimmed, context.decimalMark);
    case "boolean": {
      const lower = trimmed.toLowerCase();
      if (TRUE_WORDS.has(lower)) return true;
      if (FALSE_WORDS.has(lower)) return false;
      return undefined;
    }
    case "date":
      return readDayText(trimmed, dayOrderOf(config, context));
    case "datetime":
      return readInstantText(trimmed, {
        order: dayOrderOf(config, context),
        timeZone: fieldZone(config, context),
      });
    case "single_select": {
      const names = selectOptionNames(config);
      return (
        names.find((name) => name === trimmed) ??
        names.find((name) => name.toLowerCase() === trimmed.toLowerCase())
      );
    }
    case "multi_select": {
      const names = selectOptionNames(config);
      const picked: string[] = [];
      for (const item of splitList(trimmed)) {
        const match =
          names.find((name) => name === item) ??
          names.find((name) => name.toLowerCase() === item.toLowerCase());
        if (!match) {
          return undefined;
        }
        if (!picked.includes(match)) {
          picked.push(match);
        }
      }
      return picked;
    }
    case "user": {
      const ids: string[] = [];
      for (const item of splitList(trimmed)) {
        const id = UUID.test(item)
          ? item.toLowerCase()
          : context.resolveUser?.(item);
        if (!id) {
          return undefined;
        }
        if (!ids.includes(id)) {
          ids.push(id);
        }
      }
      return ids;
    }
    case "attachment":
      return splitList(trimmed);
    default:
      return undefined;
  }
}
