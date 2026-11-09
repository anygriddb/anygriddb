import {
  CamelCasePlugin,
  CompiledQuery,
  Kysely,
  PostgresDialect,
  sql,
  type Transaction,
} from "kysely";
import pg from "pg";
import { JsonValuesPlugin } from "./json-values.js";
import type { DB } from "./types.generated.js";

// `pg` reads these two types in the server's local time zone; AnyGridDB
// keeps dates as written and reads a timestamp without zone as UTC.
pg.types.setTypeParser(pg.types.builtins.DATE, (value: string) => value);
pg.types.setTypeParser(
  pg.types.builtins.TIMESTAMP,
  (value: string) => new Date(`${value.replace(" ", "T")}Z`),
);

/**
 * The catalog, through Kysely. Property names are camelCase in TypeScript
 * and snake_case in PostgreSQL. User tables never go through this mapping:
 * their rows are read and written with `runStatement`.
 */
export type Database = Kysely<DB>;
export type Tx = Transaction<DB>;
/** The database, or an open transaction on it. */
export type Executor = Kysely<DB>;

export type Statement = { text: string; values: readonly unknown[] };

export function createDb(
  connectionString: string,
  options: {
    max?: number;
    /** An idle connection failed, e.g. the server restarted. */
    onError?: (error: Error) => void;
  } = {},
) {
  const pool = new pg.Pool({ connectionString, max: options.max ?? 10 });
  // Without a listener, a connection's error would end the process: the
  // pool listens to idle ones and replaces them, but a connection in use
  // has no listener between two queries (a transaction waiting on the
  // application, a server restarting). Each one gets its own; the next
  // query on it then fails, and the pool drops it when it is released.
  const onError = options.onError ?? (() => undefined);
  pool.on("error", onError);
  pool.on("connect", (client) => {
    client.on("error", onError);
  });
  const db = new Kysely<DB>({
    dialect: new PostgresDialect({ pool }),
    plugins: [
      // Column names only: keys inside jsonb documents (audit snapshots,
      // view and field configs) are data and stay as written.
      new CamelCasePlugin({ maintainNestedObjectKeys: true }),
      new JsonValuesPlugin(),
    ],
  });
  return {
    db,
    pool,
    close: async () => {
      // Kysely ends the pool only once it used it itself.
      await db.destroy();
      if (!pool.ended) await pool.end();
    },
  };
}

/**
 * Runs SQL built by `@anygriddb/core` (user tables, the read engine) on
 * the database or inside a transaction. Column names come back exactly as
 * PostgreSQL sends them.
 */
export async function runStatement<Row = Record<string, unknown>>(
  executor: Executor,
  statement: Statement,
): Promise<Row[]> {
  const result = await executor
    .withoutPlugins()
    .executeQuery<Row>(
      CompiledQuery.raw(statement.text, [...statement.values]),
    );
  return result.rows;
}

/** A read under a time limit, so one query cannot hold a connection. */
export async function readWithin<T>(
  db: Database,
  timeout: string,
  body: (
    run: (statement: Statement) => Promise<Record<string, unknown>[]>,
  ) => Promise<T>,
): Promise<T> {
  if (!/^\d+(ms|s|min)$/.test(timeout)) throw new Error("Invalid timeout");
  return db.transaction().execute(async (tx) => {
    await sql.raw(`set local statement_timeout = '${timeout}'`).execute(tx);
    // Instants add and subtract in UTC, as on every engine (ADR 0005);
    // the reader's zone applies where a formula asks for it.
    await sql.raw(`set local time zone 'UTC'`).execute(tx);
    return body((statement) => runStatement(tx, statement));
  });
}
