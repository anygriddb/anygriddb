/**
 * One connection pool per source, opened on its first read (ADR 0006).
 * It holds at most the source's connection limit; every read runs in a
 * read-only transaction under the source's time limit, so a mistaken
 * query can neither write nor run long. Writes, which an administrator
 * enables per table, run in their own read-write transaction under the
 * same limit, and wait a short while at most for a row another write
 * holds. A change of the source's settings or password opens a new pool
 * and drains the old one.
 */
import { AppError } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import mysql from "mysql2/promise";
import pg from "pg";
import { decryptSecret } from "../auth/crypto.js";
import { mysqlSourceError } from "./mysql.js";
import { postgresSourceError } from "./postgres.js";
import {
  openSqlServer,
  sqlServerConnection,
  sqlServerExecute,
  firstSqlServerError,
  sqlServerSourceError,
} from "./sqlserver.js";
import { ISOLATION_LEVEL, type Connection } from "tedious";
import type { SourceSettings } from "./types.js";
import { writeError } from "./write-errors.js";
import { measureSource } from "../observability.js";

export type Statement = { text: string; values: readonly unknown[] };
export type Run = (statement: Statement) => Promise<Record<string, unknown>[]>;
/** A statement that changes rows: what it returned, and how many it changed. */
export type Change = (
  statement: Statement,
) => Promise<{ rows: Record<string, unknown>[]; affected: number }>;
export type WriteBody<T> = (run: Run, change: Change) => Promise<T>;

type Log = (error: unknown) => void;

/** One engine's pool: reads in a read-only transaction, writes, and closes. */
type Backend = {
  read<T>(body: (run: Run) => Promise<T>, log: Log): Promise<T>;
  write<T>(body: WriteBody<T>, log: Log): Promise<T>;
  end(): Promise<void>;
};

/** At most this long waiting for a row another write holds. */
const LOCK_WAIT_MS = 10_000;

/**
 * Errors of writes whose transaction was rolled back: nothing changed.
 * Any other failure of a write, such as one while it commits, leaves its
 * outcome unknown until the row is read again.
 */
const rolledBack = new WeakSet();

export function wasRolledBack(error: unknown): boolean {
  return typeof error === "object" && error !== null && rolledBack.has(error);
}

/** Runs a write's body, rolls back on failure, and marks the error so. */
async function inWrite<T>(
  body: () => Promise<T>,
  commit: () => Promise<unknown>,
  rollback: () => Promise<unknown>,
  mapped: (error: unknown) => AppError,
): Promise<T> {
  let result: T;
  try {
    result = await body();
  } catch (error) {
    const failure = mapped(error);
    const undone = await rollback().then(
      () => true,
      () => false,
    );
    if (undone) rolledBack.add(failure);
    throw failure;
  }
  try {
    await commit();
  } catch (error) {
    throw mapped(error);
  }
  return result;
}

/** Unpacks a row a read returned as one JSON object (see dialect.ts). */
function unpacked(row: Record<string, unknown>): Record<string, unknown> {
  const packed: unknown = row.ag_row;
  if (packed === undefined) return row;
  return (
    typeof packed === "string" ? JSON.parse(packed) : (packed ?? {})
  ) as Record<string, unknown>;
}

type Entry = {
  backend: Backend;
  replica: Backend | null;
  stamp: string;
  engine: string;
};

type SourceRow = {
  engine: string;
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  tlsCa: string | null;
  connectionLimit: number;
  queryTimeoutMs: number;
};

/** What a failed PostgreSQL read tells the person. */
function postgresReadError(error: unknown, log: Log): AppError {
  const code =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : undefined;
  // undefined_table, undefined_column: the schema moved under the catalog.
  if (code === "42P01" || code === "42703")
    return new AppError("source_schema_changed", { cause: error });
  const mapped = postgresSourceError(error);
  if (mapped.code !== "source_unreachable" || code === undefined) {
    if (mapped.code === "source_unreachable") log(error);
    return mapped;
  }
  // A SQL error of the client's database, not a network one.
  if (/^[0-9A-Z]{5}$/.test(code)) {
    log(error);
    return new AppError("source_query_failed", { cause: error });
  }
  return mapped;
}

/** What a failed MySQL or MariaDB read tells the person. */
function mysqlReadError(error: unknown, log: Log): AppError {
  if (error instanceof AppError) return error;
  const code =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : undefined;
  if (code === "ER_NO_SUCH_TABLE" || code === "ER_BAD_FIELD_ERROR")
    return new AppError("source_schema_changed", { cause: error });
  const mapped = mysqlSourceError(error);
  if (mapped.code !== "source_unreachable") return mapped;
  log(error);
  // A SQL error of the client's database carries its SQL state.
  if (error && typeof error === "object" && "sqlState" in error) {
    return new AppError("source_query_failed", { cause: error });
  }
  return mapped;
}

function postgresBackend(
  row: SourceRow,
  plaintext: boolean,
  log: Log,
): Backend {
  const pool = new pg.Pool({
    host: row.host,
    port: row.port,
    database: row.database,
    user: row.username,
    password: row.password,
    application_name: "AnyGridDB",
    max: row.connectionLimit,
    idleTimeoutMillis: 60_000,
    connectionTimeoutMillis: 10_000,
    ssl: plaintext
      ? false
      : { rejectUnauthorized: true, ca: row.tlsCa ?? undefined },
  });
  // A connection in use has no listener between two queries (pg-pool's is
  // for idle ones): a client's database that ends it, as when restarted or
  // dropped, would end the process. The next query on it fails instead.
  pool.on("error", log);
  pool.on("connect", (client) => {
    client.on("error", log);
  });
  return {
    async read(body, readLog) {
      let client: pg.PoolClient;
      try {
        client = await pool.connect();
      } catch (error) {
        throw postgresReadError(error, readLog);
      }
      try {
        await client.query("begin read only");
        await client.query(
          `set local statement_timeout = ${String(row.queryTimeoutMs)}`,
        );
        // Instants add and subtract in UTC, as on every engine (ADR 0005).
        await client.query("set local time zone 'UTC'");
        const result = await body(async (statement) => {
          const answer = await client.query(statement.text, [
            ...statement.values,
          ]);
          return answer.rows as Record<string, unknown>[];
        });
        await client.query("commit");
        return result;
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw postgresReadError(error, readLog);
      } finally {
        client.release();
      }
    },
    async write(body, writeLog) {
      let client: pg.PoolClient;
      try {
        client = await pool.connect();
      } catch (error) {
        throw postgresReadError(error, writeLog);
      }
      const mapped = (error: unknown) =>
        writeError("postgres", error) ?? postgresReadError(error, writeLog);
      try {
        await client.query("begin");
        return await inWrite(
          async () => {
            await client.query(
              `set local statement_timeout = ${String(row.queryTimeoutMs)}`,
            );
            await client.query(
              `set local lock_timeout = ${String(Math.min(row.queryTimeoutMs, LOCK_WAIT_MS))}`,
            );
            await client.query("set local time zone 'UTC'");
            return body(
              async (statement) =>
                (await client.query(statement.text, [...statement.values]))
                  .rows as Record<string, unknown>[],
              async (statement) => {
                const answer = await client.query(statement.text, [
                  ...statement.values,
                ]);
                return {
                  rows: answer.rows as Record<string, unknown>[],
                  affected: answer.rowCount ?? 0,
                };
              },
            );
          },
          () => client.query("commit"),
          () => client.query("rollback"),
          mapped,
        );
      } catch (error) {
        throw mapped(error);
      } finally {
        client.release();
      }
    },
    end: () => pool.end(),
  };
}

/**
 * The read engine writes `$n` placeholders (ADR 0005); MySQL's are `?`,
 * in order of appearance. Quoted text and identifiers are left alone: a
 * JSON path such as `'$[0]'` is not a placeholder.
 */
export function toPositional(statement: Statement): {
  text: string;
  values: unknown[];
} {
  const values: unknown[] = [];
  const text = rewritePlaceholders(statement, (position) => {
    values.push(statement.values[position - 1]);
    return "?";
  });
  return { text, values };
}

/** SQL Server's placeholders are named: `$3` reads `@p3`, values unchanged. */
export function toNamed(statement: Statement): string {
  return rewritePlaceholders(statement, (position) => `@p${String(position)}`);
}

/** Rewrites each `$n` outside quoted text and identifiers. */
function rewritePlaceholders(
  statement: Statement,
  render: (position: number) => string,
): string {
  const { text } = statement;
  let output = "";
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] ?? "";
    if (quote) {
      output += char;
      if (char === quote) {
        // A doubled quote stays inside the literal.
        if (text[index + 1] === quote) {
          output += quote;
          index += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      output += char;
      continue;
    }
    const placeholder =
      char === "$" ? /^\$(\d+)/.exec(text.slice(index)) : null;
    if (placeholder) {
      const position = Number(placeholder[1]);
      if (position < 1 || position > statement.values.length) {
        throw new AppError("internal_error", "placeholder");
      }
      output += render(position);
      index += placeholder[0].length - 1;
      continue;
    }
    output += char;
  }
  return output;
}

function mysqlBackend(row: SourceRow, plaintext: boolean, log: Log): Backend {
  const mariadb = row.engine === "mariadb";
  const pool = mysql.createPool({
    host: row.host,
    port: row.port,
    database: row.database,
    user: row.username,
    password: row.password,
    connectionLimit: row.connectionLimit,
    connectTimeout: 10_000,
    idleTimeout: 60_000,
    maxIdle: row.connectionLimit,
    connectAttributes: { program_name: "AnyGridDB" },
    ssl: plaintext
      ? undefined
      : { rejectUnauthorized: true, ca: row.tlsCa ?? undefined },
    supportBigNumbers: true,
    bigNumberStrings: true,
    decimalNumbers: false,
    dateStrings: true,
    timezone: "Z",
    // Each page is its own statement: keep few prepared on a connection.
    maxPreparedStatements: 64,
  });
  // Every connection reads as the engine expects (see dialect.ts):
  // quoted identifiers, `||`, literal backslashes, UTC, long link lists,
  // and the source's time limit.
  const timeLimit = mariadb
    ? `max_statement_time = ${String(row.queryTimeoutMs / 1000)}`
    : `max_execution_time = ${String(row.queryTimeoutMs)}`;
  // A value a column cannot hold is refused, never cut or clamped.
  const lockWait = Math.max(
    1,
    Math.ceil(Math.min(row.queryTimeoutMs, LOCK_WAIT_MS) / 1000),
  );
  pool.pool.on("connection", (connection) => {
    connection.query(
      `set session sql_mode = concat_ws(',', @@session.sql_mode, 'ANSI_QUOTES', 'PIPES_AS_CONCAT', 'NO_BACKSLASH_ESCAPES', 'STRICT_ALL_TABLES'), time_zone = '+00:00', group_concat_max_len = 16777216, div_precision_increment = 30, innodb_lock_wait_timeout = ${String(lockWait)}, ${timeLimit}`,
      (error: unknown) => {
        if (error) log(error);
      },
    );
  });
  return {
    async read(body, readLog) {
      let connection: mysql.PoolConnection;
      try {
        connection = await pool.getConnection();
      } catch (error) {
        throw mysqlReadError(error, readLog);
      }
      try {
        await connection.query("start transaction read only");
        const result = await body(async (statement) => {
          const positional = toPositional(statement);
          const [rows] = await connection.execute<mysql.RowDataPacket[]>(
            positional.text,
            positional.values as never,
          );
          // A result row comes as one JSON object (see dialect.ts): JSON
          // already on MySQL, its text on MariaDB.
          return rows.map(unpacked);
        });
        await connection.query("commit");
        return result;
      } catch (error) {
        await connection.query("rollback").catch(() => undefined);
        throw mysqlReadError(error, readLog);
      } finally {
        connection.release();
      }
    },
    async write(body, writeLog) {
      let connection: mysql.PoolConnection;
      try {
        connection = await pool.getConnection();
      } catch (error) {
        throw mysqlReadError(error, writeLog);
      }
      const engine = mariadb ? "mariadb" : "mysql";
      const mapped = (error: unknown) =>
        writeError(engine, error) ?? mysqlReadError(error, writeLog);
      const execute = async (statement: Statement) => {
        const positional = toPositional(statement);
        const [result] = await connection.execute(
          positional.text,
          positional.values as never,
        );
        return Array.isArray(result)
          ? {
              rows: (result as mysql.RowDataPacket[]).map(unpacked),
              affected: result.length,
            }
          : { rows: [], affected: result.affectedRows };
      };
      try {
        // Each statement reads what committed last: the rows it changes
        // are locked first, so nothing moves under the comparison.
        await connection.query(
          "set transaction isolation level read committed",
        );
        await connection.query("start transaction");
        return await inWrite(
          () =>
            body(async (statement) => (await execute(statement)).rows, execute),
          () => connection.query("commit"),
          () => connection.query("rollback"),
          mapped,
        );
      } catch (error) {
        throw mapped(error);
      } finally {
        connection.release();
      }
    },
    end: () => pool.end(),
  };
}

/** What a failed SQL Server read tells the person. */
function sqlServerReadError(raised: unknown, log: Log): AppError {
  if (raised instanceof AppError) return raised;
  const error = firstSqlServerError(raised);
  const number =
    error && typeof error === "object" && "number" in error
      ? Number(error.number)
      : undefined;
  // 208: invalid object name; 207: invalid column name.
  if (number === 208 || number === 207)
    return new AppError("source_schema_changed", { cause: error });
  // 8632: an expression services limit; 8623: the query processor ran
  // out of internal resources. Both mean a query too complex to compile.
  if (number === 8632 || number === 8623)
    return new AppError("source_query_too_complex", { cause: error });
  const mapped = sqlServerSourceError(error);
  if (mapped.code !== "source_unreachable") return mapped;
  log(error);
  // A SQL error of the client's database carries its number.
  if (number !== undefined && Number.isFinite(number)) {
    return new AppError("source_query_failed", { cause: error });
  }
  return mapped;
}

/** Begins, commits, or rolls back a transaction with tedious's own calls. */
function transaction(
  connection: Connection,
  step: "begin" | "commit" | "rollback",
): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = (error: Error | null | undefined) => {
      if (error) reject(error);
      else resolve();
    };
    if (step === "begin") {
      connection.beginTransaction(
        done,
        "anygriddb",
        ISOLATION_LEVEL.READ_COMMITTED,
      );
    } else if (step === "commit") {
      connection.commitTransaction(done);
    } else {
      connection.rollbackTransaction(done);
    }
  });
}

/**
 * Connections to a SQL Server source, at most its connection limit:
 * tedious has no pool, so this one keeps idle connections and queues the
 * reads that wait for one.
 */
function sqlServerBackend(
  row: SourceRow,
  plaintext: boolean,
  log: Log,
): Backend {
  const idle: Connection[] = [];
  const waiting: Array<(connection: Connection) => void> = [];
  let open = 0;
  let ended = false;
  const source = { ...row, engine: "sqlserver" as const };
  async function acquire(): Promise<Connection> {
    const ready = idle.pop();
    if (ready) return ready;
    if (open >= row.connectionLimit) {
      return new Promise((resolve) => waiting.push(resolve));
    }
    open += 1;
    try {
      const connection = sqlServerConnection(source, {
        allowPlaintext: plaintext,
      });
      await openSqlServer(connection);
      connection.on("end", () => {
        open -= 1;
        const at = idle.indexOf(connection);
        if (at >= 0) idle.splice(at, 1);
      });
      return connection;
    } catch (error) {
      open -= 1;
      throw error;
    }
  }
  function release(connection: Connection, broken: boolean): void {
    if (broken || ended) {
      connection.close();
      return;
    }
    const next = waiting.shift();
    if (next) next(connection);
    else idle.push(connection);
  }
  return {
    async read(body, readLog) {
      let connection: Connection;
      try {
        connection = await acquire();
      } catch (error) {
        log(error);
        throw sqlServerReadError(error, readLog);
      }
      let broken = false;
      try {
        // SQL Server has no read-only transaction: the dedicated account's
        // rights keep the read a read (ADR 0026). The driver's own
        // transaction: one begun in sp_executesql would not outlive it.
        await transaction(connection, "begin");
        const result = await body(async (statement) => {
          const { rows } = await sqlServerExecute(
            connection,
            toNamed(statement),
            statement.values,
          );
          // A result row comes as one FOR JSON object (see the dialect).
          return rows.map(unpacked);
        });
        await transaction(connection, "commit");
        return result;
      } catch (error) {
        await transaction(connection, "rollback").catch(() => {
          broken = true;
        });
        throw sqlServerReadError(error, readLog);
      } finally {
        release(connection, broken);
      }
    },
    async write(body, writeLog) {
      let connection: Connection;
      try {
        connection = await acquire();
      } catch (error) {
        log(error);
        throw sqlServerReadError(error, writeLog);
      }
      const mapped = (error: unknown) =>
        writeError("sqlserver", error) ?? sqlServerReadError(error, writeLog);
      const execute = async (statement: Statement) => {
        const answer = await sqlServerExecute(
          connection,
          toNamed(statement),
          statement.values,
        );
        return { rows: answer.rows.map(unpacked), affected: answer.affected };
      };
      let broken = false;
      try {
        await sqlServerExecute(
          connection,
          `set lock_timeout ${String(Math.min(row.queryTimeoutMs, LOCK_WAIT_MS))}`,
        );
        await transaction(connection, "begin");
        return await inWrite(
          () =>
            body(async (statement) => (await execute(statement)).rows, execute),
          () => transaction(connection, "commit"),
          () =>
            transaction(connection, "rollback").catch((error: unknown) => {
              broken = true;
              throw error;
            }),
          mapped,
        );
      } catch (error) {
        throw mapped(error);
      } finally {
        release(connection, broken);
      }
    },
    end: () => {
      ended = true;
      for (const connection of idle.splice(0)) connection.close();
      return Promise.resolve();
    },
  };
}

export class SourcePools {
  private readonly pools = new Map<string, Entry>();

  constructor(
    private readonly deps: {
      db: Database;
      key: Buffer;
      settings: SourceSettings;
      log: (error: unknown, message: string) => void;
    },
  ) {}

  private async entry(sourceId: string): Promise<Entry> {
    const row = await this.deps.db
      .selectFrom("sources")
      .selectAll()
      .where("id", "=", sourceId)
      .executeTakeFirst();
    if (!row) throw new AppError("unknown_source");
    if (!this.deps.settings.allows(row.host)) {
      throw new AppError("source_host_not_allowed", row.host);
    }
    const stamp = `${String(row.updatedAt.getTime())}:${String(row.passwordChangedAt.getTime())}`;
    const current = this.pools.get(sourceId);
    if (current?.stamp === stamp) return current;
    if (current) {
      this.pools.delete(sourceId);
      void current.backend.end().catch(() => undefined);
      void current.replica?.end().catch(() => undefined);
    }
    const source: SourceRow = {
      engine: row.engine,
      host: row.host,
      port: row.port,
      database: row.database,
      username: row.username,
      password: decryptSecret(
        row.passwordCiphertext,
        row.passwordNonce,
        this.deps.key,
      ),
      tlsCa: row.tlsCa,
      connectionLimit: row.connectionLimit,
      queryTimeoutMs: row.queryTimeoutMs,
    };
    const log: Log = (error) =>
      this.deps.log(error, "source connection failed");
    const plaintext = this.deps.settings.allowPlaintext;
    const open = (target: SourceRow): Backend => {
      switch (row.engine) {
        case "postgres":
          return postgresBackend(target, plaintext, log);
        case "mysql":
        case "mariadb":
          return mysqlBackend(target, plaintext, log);
        case "sqlserver":
          return sqlServerBackend(target, plaintext, log);
        default:
          throw new AppError("source_engine_unsupported", row.engine);
      }
    };
    const backend = open(source);
    let replica: Backend | null = null;
    if (row.replicaHost && row.replicaPort) {
      if (!this.deps.settings.allows(row.replicaHost)) {
        throw new AppError("source_host_not_allowed", row.replicaHost);
      }
      const replicaPassword =
        row.replicaPasswordCiphertext && row.replicaPasswordNonce
          ? decryptSecret(
              row.replicaPasswordCiphertext,
              row.replicaPasswordNonce,
              this.deps.key,
            )
          : source.password;
      replica = open({
        ...source,
        host: row.replicaHost,
        port: row.replicaPort,
        database: row.replicaDatabase ?? row.database,
        username: row.replicaUsername ?? row.username,
        password: replicaPassword,
      });
    }
    const entry = { backend, replica, stamp, engine: row.engine };
    this.pools.set(sourceId, entry);
    return entry;
  }

  /** Runs `body` against the source in one read-only transaction. */
  async read<T>(sourceId: string, body: (run: Run) => Promise<T>): Promise<T> {
    const { backend, replica, engine } = await this.entry(sourceId);
    const runRead = (target: Backend) =>
      measureSource({ id: sourceId, engine }, "read", () =>
        target.read(body, (cause) =>
          this.deps.log(cause, "source read failed"),
        ),
      );
    if (!replica) return runRead(backend);
    try {
      return await runRead(replica);
    } catch (error) {
      // A replica that cannot be reached hands the read to the primary. One
      // that ran out of time does not: the same query would load the
      // primary as long, which the replica is there to spare.
      if (error instanceof AppError && error.code === "source_unreachable") {
        this.deps.log(error, "source replica unreachable; reading primary");
        return runRead(backend);
      }
      throw error;
    }
  }

  /**
   * Runs `body` against the source in one read-write transaction. When it
   * fails, `wasRolledBack` tells whether nothing changed.
   */
  async write<T>(sourceId: string, body: WriteBody<T>): Promise<T> {
    const { backend, engine } = await this.entry(sourceId);
    return measureSource({ id: sourceId, engine }, "write", () =>
      backend.write(body, (cause) =>
        this.deps.log(cause, "source write failed"),
      ),
    );
  }

  /** Closes a source's pool, as when it is deleted. */
  async forget(sourceId: string): Promise<void> {
    const current = this.pools.get(sourceId);
    this.pools.delete(sourceId);
    await current?.backend.end().catch(() => undefined);
    await current?.replica?.end().catch(() => undefined);
  }

  async close(): Promise<void> {
    const all = [...this.pools.values()];
    this.pools.clear();
    await Promise.allSettled(
      all.flatMap((entry) => [
        entry.backend.end(),
        ...(entry.replica ? [entry.replica.end()] : []),
      ]),
    );
  }
}

let current: SourcePools | undefined;

/** Set once at start; reads of external tables go through it. */
export function setSourcePools(pools: SourcePools | undefined): void {
  current = pools;
}

export function sourcePools(): SourcePools {
  if (!current) throw new Error("Source pools not started");
  return current;
}
