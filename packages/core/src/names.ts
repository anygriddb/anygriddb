import { z } from "zod";
import { RESERVED_COLUMN_NAMES } from "./field-types";
import { AppError } from "./errors";
import { trimRuns } from "./plain-text";

export const COLUMN_NAME = /^[a-z_][a-z0-9_]*$/;

export const columnNameSchema = z.string().regex(COLUMN_NAME).max(63);

/**
 * What no name holds: control characters, line and paragraph breaks, and
 * the marks that turn the direction of a text around, with which a name
 * could be read as another.
 */
const NOT_IN_A_NAME = "\\p{Cc}\\p{Zl}\\p{Zp}\\u202A-\\u202E\\u2066-\\u2069";

/**
 * Names of bases, tables, views, folders, dashboards, widgets, groups,
 * and people: any text of one line that holds a letter or a digit, so
 * that there is something to read, to sort, and to search. A sign of
 * money, a comma, a percent sign, a dash, a picture: all are text.
 */
export const labelSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(new RegExp(`^(?=.*[\\p{L}\\p{N}])[^${NOT_IN_A_NAME}]+$`, "u"));

/**
 * Words that came from elsewhere (a file, an import, an identity
 * provider) as a name may hold them: what no name holds becomes a
 * space, runs of spaces one, and the rest is cut to a name's length.
 * The result is still to be asked of `labelSchema`: nothing may be left.
 */
export function tidyLabel(text: string): string {
  return text
    .replace(new RegExp(`[${NOT_IN_A_NAME}]`, "gu"), " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
    .trim();
}

/** Column labels: any printable text except braces, which delimit formula references. */
export const columnLabelSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[^\p{Cc}{}]+$/u);

export function isReservedColumnName(name: string): boolean {
  return RESERVED_COLUMN_NAMES.has(name) || name.startsWith("ag_");
}

/**
 * Derives a stable snake_case column name from a label, unique against
 * `taken`. `Prix TTC (€)` becomes `prix_ttc`, a clash becomes `prix_ttc_2`.
 */
export function deriveColumnName(
  label: string,
  taken: ReadonlySet<string>,
): string {
  const base =
    trimRuns(
      label
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_"),
      "_",
    ).slice(0, 48) || "field";
  const safe =
    /^[0-9]/.test(base) || isReservedColumnName(base) ? `f_${base}` : base;
  if (!taken.has(safe)) {
    return safe;
  }
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const candidate = `${safe}_${suffix}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
  throw new AppError("invalid_column");
}
