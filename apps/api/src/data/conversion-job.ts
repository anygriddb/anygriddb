import {
  AppError,
  buildConversionGuard,
  buildConversionMarks,
  buildConversionStamp,
  buildConversionTempColumn,
  buildConversionUniqueIndex,
  buildCountLocked,
  buildCountValues,
  buildDropConversionColumns,
  buildDropConversionGuard,
  buildRenameOption,
  convertColumnJobInputSchema,
} from "@anygriddb/core";
import { runStatement, type Database, type JobRow } from "@anygriddb/db";
import { sql } from "kysely";
import { runRows, withAudit } from "./audit-context.js";
import {
  CONVERSION_BATCH,
  readConverted,
  writeConverted,
  type ConvertedField,
} from "./conversion-rows.js";
import type { TableRow } from "./engine.js";
import { postgresCode, uniqueViolation } from "./pg-error.js";
import {
  applyColumnUpdate,
  planColumnUpdate,
  type ColumnPlan,
  type ColumnUpdate,
} from "./schema-ops.js";

/**
 * A field of a large table converted in the background (ADR 0116): the
 * new values are written beside the old ones by batches, the table being
 * read-only, and a short transaction puts them in the field's place.
 * Until then the field is untouched, so a failure at any point leaves the
 * table as it was. Readers are never held but for the two short steps.
 */
/** How often a step that needs the table alone asks for it again. */
const LOCK_ATTEMPTS = 20;
const LOCK_PAUSE_MS = 500;
/** The unique index is built while the table takes no write, readers aside. */
const INDEX_TIMEOUT = "10min";

/**
 * Runs a step that needs the table alone. It waits for it a few seconds
 * at a time: a long wait would hold every reader queued behind it.
 */
async function whenAlone<T>(step: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await step();
    } catch (error) {
      if (postgresCode(error) !== "55P03" || attempt >= LOCK_ATTEMPTS) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_PAUSE_MS));
    }
  }
}

/** Takes away what an unfinished conversion left on its table. */
async function clearConversion(
  db: Database,
  physicalName: string,
  column: string,
): Promise<void> {
  await whenAlone(() =>
    db.transaction().execute(async (tx) => {
      await sql`set local lock_timeout = '3s'`.execute(tx);
      const exists = await sql<{ found: string | null }>`
        select to_regclass(${`"${physicalName}"`})::text as found
      `.execute(tx);
      if (!exists.rows[0]?.found) return;
      await runStatement(tx, buildDropConversionGuard(physicalName));
      for (const statement of buildDropConversionColumns({
        table: physicalName,
        column,
      })) {
        await runStatement(tx, statement);
      }
    }),
  );
}

/**
 * Gives a table back after the worker converting it died: the job is no
 * longer running, and what it had begun goes away.
 */
export async function abandonConversion(
  db: Database,
  job: Pick<JobRow, "input" | "tableId">,
): Promise<void> {
  const parsed = convertColumnJobInputSchema.safeParse(job.input);
  if (!parsed.success || !job.tableId) return;
  const table = await db
    .selectFrom("dataTables")
    .select("physicalName")
    .where("id", "=", job.tableId)
    .executeTakeFirst();
  if (!table) return;
  await clearConversion(db, table.physicalName, parsed.data.name);
}

/** The guard on, the column beside the field, renamed options written. */
async function prepare(
  db: Database,
  userId: string,
  table: TableRow,
  input: ColumnUpdate,
  plan: ColumnPlan,
  jobId: string,
): Promise<void> {
  await whenAlone(() =>
    withAudit(
      db,
      {
        userId,
        tableId: table.id,
        reason: input.reason ?? null,
        source: "web",
      },
      async (tx) => {
        await sql`set local lock_timeout = '3s'`.execute(tx);
        // Written first: the guard refuses any write but the batches'.
        for (const rename of plan.renames) {
          await runRows(
            tx,
            buildRenameOption({
              table: table.physicalName,
              column: input.name,
              multiple: plan.column.fieldType === "multi_select",
              from: rename.from,
              to: rename.to,
            }),
          );
        }
        await runRows(tx, buildConversionGuard(table.physicalName, jobId));
        await runRows(
          tx,
          buildConversionTempColumn({
            table: table.physicalName,
            column: input.name,
            to: plan.fieldType,
          }),
        );
        await runRows(tx, buildConversionMarks(table.physicalName));
        // Nothing can be sealed from here on: a sealed row refuses the batch.
        const [locked] = await runRows(
          tx,
          buildCountLocked(table.physicalName),
        );
        if (Number(locked?.count ?? 0) > 0) throw new AppError("row_locked");
      },
    ),
  );
}

const AS_CONVERSION = "conversion";

/**
 * The new values, beside the field. Each row's "last modified" stays: the
 * field has not changed yet, and may not. Rows whose value will differ are
 * marked, for `stampChanged`.
 */
async function writeBatches(
  db: Database,
  userId: string,
  table: TableRow,
  input: ColumnUpdate,
  field: ConvertedField,
  jobId: string,
  progress: (done: number, total?: number | null) => Promise<void>,
): Promise<{ read: number; lost: number }> {
  const [counted] = await runStatement(
    db,
    buildCountValues({ table: table.physicalName, column: input.name }),
  );
  const total = Number(counted?.count ?? 0);
  await progress(0, total);
  let after: string | null = null;
  let read = 0;
  let lost = 0;
  for (;;) {
    const rows = await readConverted(db, field, after, CONVERSION_BATCH);
    await withAudit(
      db,
      {
        userId,
        tableId: table.id,
        reason: input.reason ?? null,
        source: AS_CONVERSION,
      },
      async (tx) => {
        await sql`select set_config('anygrid.converting', ${jobId}, true)`.execute(
          tx,
        );
        await writeConverted(tx, field, rows, { beside: true, marks: true });
      },
    );
    read += rows.length;
    lost += rows.filter((row) => row.value === undefined).length;
    after = rows.at(-1)?.id ?? after;
    await progress(read, total);
    if (rows.length < CONVERSION_BATCH) return { read, lost };
  }
}

/** Once the field has its new values: the rows they changed are stamped. */
async function stampChanged(
  db: Database,
  userId: string,
  table: TableRow,
  input: ColumnUpdate,
  jobId: string,
): Promise<void> {
  let after: string | null = null;
  for (;;) {
    const from: string | null = after;
    const rows: Record<string, unknown>[] = await withAudit(
      db,
      {
        userId,
        tableId: table.id,
        reason: input.reason ?? null,
        source: AS_CONVERSION,
      },
      async (tx) => {
        await sql`select set_config('anygrid.converting', ${jobId}, true), set_config('anygrid.conversion_stamp', 'on', true)`.execute(
          tx,
        );
        return runRows(
          tx,
          buildConversionStamp({
            table: table.physicalName,
            after: from,
            limit: CONVERSION_BATCH,
          }),
        );
      },
    );
    const count = Number(rows[0]?.read ?? 0);
    after = typeof rows[0]?.last === "string" ? rows[0].last : after;
    if (count < CONVERSION_BATCH) return;
  }
}

/** Runs a conversion to its end, or leaves the table as it found it. */
export async function runConversion(
  db: Database,
  input: {
    userId: string;
    table: TableRow;
    job: Pick<JobRow, "id" | "input">;
    progress: (done: number, total?: number | null) => Promise<void>;
  },
): Promise<{ converted: number; lost: number }> {
  const { userId, table, job, progress } = input;
  const asked = convertColumnJobInputSchema.parse(job.input);
  const current = await db
    .selectFrom("dataColumns")
    .select("fieldType")
    .where("tableId", "=", table.id)
    .where("name", "=", asked.name)
    .where("deletedAt", "is", null)
    .executeTakeFirst();
  if (!current) throw new AppError("unknown_column", asked.name);
  // A run that died after its switch has nothing left to do.
  if (current.fieldType === asked.fieldType) return { converted: 0, lost: 0 };
  const first = await planColumnUpdate(db, table, asked, job.id);
  // What a run that died may have left.
  await clearConversion(db, table.physicalName, asked.name);
  try {
    await prepare(db, userId, table, asked, first, job.id);
    // The table no longer moves: options taken from its values are final.
    const plan =
      (first.fieldType === "single_select" ||
        first.fieldType === "multi_select") &&
      first.asked.options === undefined
        ? await planColumnUpdate(
            db,
            table,
            { ...asked, optionRenames: [] },
            job.id,
          )
        : first;
    const { read, lost } = await writeBatches(
      db,
      userId,
      table,
      asked,
      {
        table: table.physicalName,
        column: asked.name,
        from: plan.column.fieldType,
        to: plan.fieldType,
        config: plan.config,
        timeZone: asked.timeZone,
      },
      job.id,
      progress,
    );
    if (plan.unique) {
      await db.transaction().execute(async (tx) => {
        await sql
          .raw(`set local statement_timeout = '${INDEX_TIMEOUT}'`)
          .execute(tx);
        await runStatement(
          tx,
          buildConversionUniqueIndex({
            table: table.physicalName,
            column: asked.name,
          }),
        );
      });
    }
    await whenAlone(() =>
      applyColumnUpdate(
        db,
        userId,
        table,
        asked,
        { ...plan, renames: [] },
        "web",
        true,
      ),
    );
    await stampChanged(db, userId, table, asked, job.id);
    await clearConversion(db, table.physicalName, asked.name);
    return { converted: read - lost, lost };
  } catch (error) {
    await clearConversion(db, table.physicalName, asked.name);
    throw uniqueViolation(error) ?? error;
  }
}
