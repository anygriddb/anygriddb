import { z } from "zod";
import { RESERVED_COLUMN_NAMES } from "./field-types";
import { AppError } from "./errors";
import { trimRuns } from "./plain-text";

export const COLUMN_NAME = /^[a-z_][a-z0-9_]*$/;

export const columnNameSchema = z.string().regex(COLUMN_NAME).max(63);

/** Base, table, and view names. */
export const labelSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[\p{L}\p{N}][\p{L}\p{N} _.'()&/+:#-]*$/u);

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
