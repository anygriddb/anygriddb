import { z } from "zod";
import { isDecimalString, numberToDecimal, toDecimalString } from "./decimal";
import { selectOptionNames, type ColumnConfig } from "./field-config";
import {
  isComputedType,
  isRelationType,
  isSystemType,
  type FieldType,
} from "./field-types";
import { AppError } from "./errors";

export const ATTACHMENT_KEY = /^att[A-Za-z0-9_-]{20,80}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PHONE = /^\+?[0-9 ().-]{3,32}$/;
const ISO_DATETIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})$/;

const MAX_ARRAY_ITEMS = 100;

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

export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    year >= 1 &&
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export function isIsoDateTime(value: string): boolean {
  return (
    ISO_DATETIME.test(value) &&
    isIsoDate(value.slice(0, 10)) &&
    Number.isFinite(Date.parse(value))
  );
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
      if (typeof value === "string" && value.length <= 4_000) return;
      break;
    case "long_text":
      if (typeof value === "string" && value.length <= 20_000) return;
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
    case "number": {
      // Exact as a decimal string (ADR 0023); a finite number is accepted
      // from older clients and converted on typecast.
      const decimal = isDecimalString(value);
      if (!decimal && !(typeof value === "number" && Number.isFinite(value))) {
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
        isUniqueStrings(value, 20) &&
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

/**
 * Typed text as a plain decimal: currency signs and spaces go, and a comma
 * is a decimal separator in `1.234,5` or `12,5` and a group one otherwise.
 */
function normalizeNumberText(raw: string): string | undefined {
  const cleaned = raw
    .trim()
    .replace(/[\s\u00a0\u202f]/g, "")
    .replace(/[€$£¥%]/g, "");
  if (cleaned === "") {
    return undefined;
  }
  const normalized =
    /^-?\d{1,3}(?:\.\d{3})+,\d+$/.test(cleaned) || /^-?\d+,\d+$/.test(cleaned)
      ? cleaned.replace(/\./g, "").replace(",", ".")
      : cleaned.replace(/,/g, "");
  return /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(normalized)
    ? normalized
    : undefined;
}

function parseLooseNumber(raw: string): number | undefined {
  const normalized = normalizeNumberText(raw);
  if (normalized === undefined) return undefined;
  const value = Number(normalized);
  return Number.isFinite(value) ? value : undefined;
}

/** The exact decimal a person typed, never rounded through a float. */
function parseLooseDecimal(raw: string): string | undefined {
  const normalized = normalizeNumberText(raw);
  return normalized === undefined ? undefined : toDecimalString(normalized);
}

function parseLooseDate(raw: string): string | undefined {
  const value = raw.trim();
  if (isIsoDate(value)) {
    return value;
  }
  if (isIsoDateTime(value)) {
    return value.slice(0, 10);
  }
  const european = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(value);
  if (european) {
    const iso = `${european[3]}-${(european[2] ?? "").padStart(2, "0")}-${(european[1] ?? "").padStart(2, "0")}`;
    return isIsoDate(iso) ? iso : undefined;
  }
  return undefined;
}

function parseDuration(raw: string): number | undefined {
  const value = raw.trim();
  const clock = /^(\d+):([0-5]\d)(?::([0-5]\d(?:\.\d+)?))?$/.exec(value);
  if (clock) {
    return (
      Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3] ?? 0)
    );
  }
  return parseLooseNumber(value);
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
};

/**
 * Turns loose input (pasted text, CSV cells, API `typecast`) into a value
 * the column accepts, or `undefined` when it cannot. Never throws.
 */
export function coerceCellValue(
  column: CellColumn,
  raw: unknown,
  context: CoerceContext = {},
): CellValue | undefined {
  const candidate = coerceRaw(column, raw, context);
  if (candidate === undefined) {
    return undefined;
  }
  try {
    assertCellValue(column, candidate);
    return candidate;
  } catch {
    return undefined;
  }
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
  if (Array.isArray(raw)) {
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
      return text.replace(/\n/g, " ").slice(0, 4_000);
    case "long_text":
      return text.slice(0, 20_000);
    case "email":
    case "url":
    case "phone":
      return trimmed;
    case "number":
      return parseLooseDecimal(trimmed);
    case "rating": {
      const stars = trimmed.match(/[★⭐]/gu)?.length ?? 0;
      const value = stars > 0 ? stars : parseLooseNumber(trimmed);
      return value === undefined ? undefined : Math.round(value);
    }
    case "duration":
      return parseDuration(trimmed);
    case "boolean": {
      const lower = trimmed.toLowerCase();
      if (TRUE_WORDS.has(lower)) return true;
      if (FALSE_WORDS.has(lower)) return false;
      return undefined;
    }
    case "date":
      return parseLooseDate(trimmed);
    case "datetime": {
      if (isIsoDateTime(trimmed)) return trimmed;
      const date = parseLooseDate(trimmed);
      if (date) return `${date}T00:00:00Z`;
      const parsed = Date.parse(trimmed);
      return Number.isFinite(parsed)
        ? new Date(parsed).toISOString()
        : undefined;
    }
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
