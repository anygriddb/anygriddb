import {
  buildConversionRead,
  buildConversionWrite,
  type CellValue,
  type ColumnConfig,
  conversionChanges,
  convertCell,
  type FieldType,
  type StoredCell,
} from "@anygriddb/core";
import { runStatement, type Database, type Tx } from "@anygriddb/db";
import { sql } from "kysely";

/**
 * The values of a field being converted: read a batch at a time, each
 * passed through the cell's own rule, and written back.
 */

export const CONVERSION_BATCH = 2_000;
/** A write carries at most this much JSON: long texts make few rows. */
const WRITE_CHARS = 4_000_000;

/** A field being converted, and what it becomes. */
export type ConvertedField = {
  table: string;
  column: string;
  from: FieldType;
  to: FieldType;
  config: ColumnConfig;
  timeZone?: string | undefined;
};

type ConvertedRow = {
  id: string;
  stored: StoredCell;
  /** The instant it held, for an example in the person's zone. */
  instant: string | null;
  value: CellValue | undefined;
  changed: boolean;
};

export async function readConverted(
  executor: Database | Tx,
  field: ConvertedField,
  after: string | null,
  limit: number,
): Promise<ConvertedRow[]> {
  const rows = await runStatement(
    executor,
    buildConversionRead({
      table: field.table,
      column: field.column,
      from: field.from,
      to: field.to,
      ...(field.timeZone === undefined ? {} : { timeZone: field.timeZone }),
      after,
      limit,
    }),
  );
  const column = { fieldType: field.to, config: field.config };
  return rows.map((row) => {
    const stored = row.value as StoredCell;
    const value = convertCell(field.from, column, stored, field.timeZone);
    const instant = typeof row.instant === "string" ? row.instant : null;
    return {
      id: row.id as string,
      stored,
      instant,
      value,
      // An instant becoming its day loses its time, whatever the day reads.
      changed: conversionChanges(instant ?? stored, value, field.to),
    };
  });
}

/** Writes rows' new values, a few megabytes of them at a time. */
export async function writeConverted(
  tx: Tx,
  field: ConvertedField,
  rows: readonly ConvertedRow[],
  options: { beside: boolean; marks?: boolean },
): Promise<void> {
  let chunk: Array<{ id: string; value: CellValue; changed: boolean }> = [];
  let chars = 0;
  const flush = async () => {
    if (chunk.length === 0) return;
    await runStatement(
      tx,
      buildConversionWrite({
        table: field.table,
        column: field.column,
        to: field.to,
        beside: options.beside,
        marks: options.marks === true,
        rows: chunk,
      }),
    );
    chunk = [];
    chars = 0;
  };
  for (const row of rows) {
    const value = row.value ?? null;
    const size = typeof value === "string" ? value.length : 64;
    if (chars + size > WRITE_CHARS) await flush();
    chunk.push({ id: row.id, value, changed: row.changed });
    chars += size;
  }
  await flush();
}

/** How the row trigger stamps what follows: keeps the stamp, or moves it. */
const setStamping = (tx: Tx, stamps: boolean) =>
  sql`select set_config('anygrid.converting', 'inline', true), set_config('anygrid.conversion_stamp', ${stamps ? "on" : ""}, true)`.execute(
    tx,
  );

/**
 * A conversion inside one transaction. Beside the field, a row whose value
 * stays the same keeps its "last modified". In the field itself, only the
 * rows whose value changes are written.
 */
export async function rewriteField(
  tx: Tx,
  field: ConvertedField,
  beside: boolean,
): Promise<void> {
  let after: string | null = null;
  for (;;) {
    const rows: ConvertedRow[] = await readConverted(
      tx,
      field,
      after,
      CONVERSION_BATCH,
    );
    const changed = rows.filter((row) => row.changed);
    if (beside) {
      await setStamping(tx, false);
      await writeConverted(
        tx,
        field,
        rows.filter((row) => !row.changed),
        { beside },
      );
      // Emptied, a row writes nothing new beside the field: it is said here.
      await setStamping(tx, true);
    }
    await writeConverted(tx, field, changed, { beside });
    if (rows.length < CONVERSION_BATCH) {
      await sql`select set_config('anygrid.converting', '', true), set_config('anygrid.conversion_stamp', '', true)`.execute(
        tx,
      );
      return;
    }
    after = rows.at(-1)?.id ?? after;
  }
}

function inZone(instant: string, timeZone: string): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(new Date(instant));
}

/**
 * What a conversion would do to at most `limit` values, and a few examples,
 * those it empties first, then those it writes differently. Changes nothing.
 */
export async function tallyConversion(
  db: Database,
  field: ConvertedField,
  limit: number,
): Promise<{
  total: number;
  lost: number;
  rewritten: number;
  samples: Array<{ before: unknown; after: unknown }>;
}> {
  const zone = field.timeZone;
  const shown = (row: ConvertedRow) => ({
    before:
      row.instant !== null && zone !== undefined
        ? inZone(row.instant, zone)
        : row.stored,
    after:
      field.to === "datetime" &&
      zone !== undefined &&
      typeof row.value === "string"
        ? inZone(row.value, zone)
        : (row.value ?? null),
  });
  const emptied: ConvertedRow[] = [];
  const different: ConvertedRow[] = [];
  const same: ConvertedRow[] = [];
  let total = 0;
  let lost = 0;
  let rewritten = 0;
  let after: string | null = null;
  while (total < limit) {
    const rows: ConvertedRow[] = await readConverted(
      db,
      field,
      after,
      Math.min(CONVERSION_BATCH, limit - total),
    );
    for (const row of rows) {
      total += 1;
      if (row.value === undefined) {
        lost += 1;
        if (emptied.length < 5) emptied.push(row);
      } else if (row.changed) {
        rewritten += 1;
        if (different.length < 5) different.push(row);
      } else if (same.length < 5) {
        same.push(row);
      }
    }
    if (rows.length < CONVERSION_BATCH) break;
    after = rows.at(-1)?.id ?? after;
  }
  return {
    total,
    lost,
    rewritten,
    samples: [...emptied, ...different, ...same].slice(0, 5).map(shown),
  };
}
