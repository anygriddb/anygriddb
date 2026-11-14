import { z } from "zod";
import { labelSchema } from "./names";
import { MAX_SNAPSHOT_TABLES } from "./snapshot";

/**
 * A workbook made a base (ADR 0078): an `.xlsx` file, as a spreadsheet
 * program saves one, each chosen worksheet a table of the new base.
 */

/** The worksheets one workbook brings at most: a base's tables. */
export const MAX_WORKBOOK_SHEETS = MAX_SNAPSHOT_TABLES;

/** Worksheets by their place in the file, from 0, each once. */
const sheetsSchema = z
  .array(z.int().min(0).max(9_999))
  .min(1)
  .max(MAX_WORKBOOK_SHEETS)
  .refine((sheets) => new Set(sheets).size === sheets.length);

/** A staged workbook made a base: which sheets, and the base's name. */
export const importWorkbookInputSchema = z
  .object({
    importId: z.uuid(),
    name: labelSchema.optional(),
    sheets: sheetsSchema,
  })
  .strict();

export const importWorkbookJobInputSchema = z
  .object({
    importId: z.uuid(),
    name: labelSchema,
    sheets: sheetsSchema,
  })
  .strict();
