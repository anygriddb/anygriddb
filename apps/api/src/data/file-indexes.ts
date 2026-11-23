/**
 * The index of each file field, which finds the rows holding a file. A new
 * field gets it in the transaction that adds it. A field of an instance
 * older than the index gets it here, at the start, beside the writes: a
 * migration runs in a transaction, where an index cannot be built that way.
 */
import {
  buildDropIndexConcurrently,
  buildFileIndex,
  buildFileIndexStates,
  type EngineCatalog,
} from "@anygriddb/core";
import { type Database, runStatement } from "@anygriddb/db";
import pg from "pg";

const LOCK = "anygriddb.file_indexes";
/** Opening the connection this work has to itself. */
const CONNECT_MS = 30_000;
/** One index on a very large table, waits for running writes included. */
const BUILD_MS = 2 * 60 * 60 * 1000;

type IndexState = { column: string; name: string; valid: boolean };

type Log = {
  info: (fields: object, message: string) => void;
  error: (fields: object, message: string) => void;
};

/** Every file field of the instance's own tables. */
function fileFields(db: Database) {
  return db
    .selectFrom("dataColumns as c")
    .innerJoin("dataTables as t", "t.id", "c.tableId")
    .select(["t.physicalName as table", "c.name as column"])
    .where("c.fieldType", "=", "attachment")
    .where("t.storage", "=", "native")
    .execute();
}

/**
 * How many file fields have no usable index: what a role that cannot build
 * them tells its operator at the start.
 */
export async function fileIndexesMissing(db: Database): Promise<number> {
  const usable = new Map<string, Set<string>>();
  let missing = 0;
  for (const field of await fileFields(db)) {
    let columns = usable.get(field.table);
    if (!columns) {
      const states = await runStatement<IndexState>(
        db,
        buildFileIndexStates(field.table),
      );
      columns = new Set(
        states.filter((state) => state.valid).map((state) => state.column),
      );
      usable.set(field.table, columns);
    }
    if (!columns.has(field.column)) missing += 1;
  }
  return missing;
}

/** Whether every file field the engine reads has a usable index. */
export async function fileFieldsIndexed(
  db: Database,
  engine: EngineCatalog,
): Promise<boolean> {
  const fields = engine.table.columns.filter(
    (column) => column.fieldType === "attachment",
  );
  if (fields.length === 0) return true;
  const states = await runStatement<IndexState>(
    db,
    buildFileIndexStates(engine.table.physicalName),
  );
  const usable = new Set(
    states.filter((state) => state.valid).map((state) => state.column),
  );
  return fields.every((column) => usable.has(column.name));
}

/**
 * Builds the indexes file fields lack, one at a time, on a connection of
 * its own: the pool's limits are for requests, and it stays whole. Several
 * instances starting together leave the work to the first. A field that
 * fails is logged and tried again at the next start.
 */
export async function buildFileIndexes(
  db: Database,
  connectionString: string,
  log: Log,
): Promise<void> {
  const fields = await fileFields(db);
  if (fields.length === 0) return;
  const client = new pg.Client({
    connectionString,
    application_name: "anygriddb-file-indexes",
    connectionTimeoutMillis: CONNECT_MS,
    statement_timeout: BUILD_MS,
  });
  client.on("error", (error: Error) => {
    log.error({ err: error }, "file index connection failed");
  });
  await client.connect();
  try {
    const { rows } = await client.query<{ got: boolean }>(
      `select pg_try_advisory_lock(hashtext($1)) as got`,
      [LOCK],
    );
    if (!rows[0]?.got) return;
    for (const field of fields) {
      try {
        const states = await client.query<IndexState>(
          buildFileIndexStates(field.table).text,
          [...buildFileIndexStates(field.table).values],
        );
        const own = states.rows.filter(
          (state) => state.column === field.column,
        );
        if (own.some((state) => state.valid)) continue;
        for (const state of own) {
          await client.query(buildDropIndexConcurrently(state.name).text);
        }
        await client.query(
          buildFileIndex({
            table: field.table,
            column: field.column,
            concurrently: true,
          }).text,
        );
        log.info({ table: field.table }, "file index built");
      } catch (error) {
        log.error({ err: error, table: field.table }, "file index failed");
      }
    }
  } finally {
    await client.end();
  }
}
