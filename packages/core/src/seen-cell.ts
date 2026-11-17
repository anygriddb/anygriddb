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
import { sameCell } from "./query/external-write";

const DATE_LIKE = /^\d{4}-\d{2}-\d{2}(?:[T ]|$)/;

export function sameAsSeen(
  fieldType: string,
  current: unknown,
  seen: unknown,
): boolean {
  const left = kept(fieldType, current);
  const right = kept(fieldType, seen);
  if (sameCell(left, right)) return true;
  if (fieldType !== "date" && fieldType !== "datetime") return false;
  const a = instant(left);
  return a !== null && a === instant(right);
}

/** A cell as its field keeps it: an empty one is null, whatever said so. */
function kept(fieldType: string, value: unknown): unknown {
  if (value === undefined || value === null || value === "") return null;
  if (fieldType === "boolean") return value === true ? true : null;
  if (fieldType === "json") return ordered(parsed(value));
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

/** A document sent as text is the document it spells. */
function parsed(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    // Not a document: compared as the text it is.
    return value;
  }
}

/** The same document whatever order its keys were written in. */
function ordered(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : item,
  );
}

/** The moment a date or a date and time names, however it is spelled. */
function instant(value: unknown): number | null {
  if (typeof value !== "string" || !DATE_LIKE.test(value)) return null;
  const moment = Date.parse(
    value.length === 10 ? `${value}T00:00:00.000Z` : value.replace(" ", "T"),
  );
  return Number.isFinite(moment) ? moment : null;
}
