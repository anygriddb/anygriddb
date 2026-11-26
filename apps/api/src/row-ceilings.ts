/**
 * The most rows one file brings in, and one job writes out (ADR 0132,
 * family 4): what the operator's environment fixes, else what
 * Administration's "Limits and usage" sets, else the catalogue's value.
 * Read when a file or a job starts, through the settings' cache, so every
 * process follows a change within seconds.
 */
import { limitIn } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import type { Env } from "./env.js";
import { readGateSettings } from "./settings.js";

/** What the environment fixes of them: it wins when set (ADR 0083). */
export type RowsFixed = Pick<Env, "IMPORT_MAX_ROWS" | "EXPORT_MAX_ROWS">;

/** The most rows one imported file, snapshot or workbook may bring in. */
export async function importCeiling(
  db: Database,
  fixed: RowsFixed = {},
): Promise<number> {
  return (
    fixed.IMPORT_MAX_ROWS ??
    limitIn("import.max_rows", (await readGateSettings(db)).limits)
  );
}

/** The most rows one export, snapshot or restore point writes out. */
export async function exportCeiling(
  db: Database,
  fixed: RowsFixed = {},
): Promise<number> {
  return (
    fixed.EXPORT_MAX_ROWS ??
    limitIn("export.max_rows", (await readGateSettings(db)).limits)
  );
}
