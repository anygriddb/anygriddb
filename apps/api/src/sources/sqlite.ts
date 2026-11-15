/**
 * SQLite as a client database: the `database` field is an absolute file path
 * on the API host. There is no network TLS; the operator's path allow-list
 * gates which directories may hold files.
 */
import { AppError } from "@anygriddb/core";
import { DatabaseSync } from "node:sqlite";
import { resolveSqliteDatabase, type SqlitePathAccess } from "./sqlite-path.js";
import type { SourceCheck, SourceConnection } from "./types.js";

export type SqliteHandle = {
  db: DatabaseSync;
  serverVersion: string;
};

/** Opens the file the source names; refuses a path outside the allow-list. */
export function connectSqlite(
  source: SourceConnection,
  access: SqlitePathAccess,
): SqliteHandle {
  const path = resolveSqliteDatabase(source.database, access);
  try {
    const db = new DatabaseSync(path, { readOnly: false });
    db.exec("pragma foreign_keys = on");
    const row = db.prepare("select sqlite_version() as version").get() as
      { version: string } | undefined;
    if (!row?.version) {
      db.close();
      throw new AppError("source_unreachable");
    }
    const [major = 0, minor = 0] = row.version.split(".").map(Number);
    if (major < 3 || (major === 3 && minor < 39)) {
      db.close();
      throw new AppError("source_version_unsupported", row.version);
    }
    return { db, serverVersion: row.version };
  } catch (error) {
    throw sqliteSourceError(error);
  }
}

export function checkSqlite(
  source: SourceConnection,
  access: SqlitePathAccess,
): Promise<SourceCheck> {
  const { db, serverVersion } = connectSqlite(source, access);
  db.close();
  return Promise.resolve({ serverVersion });
}

export function sqliteSourceError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/unable to open|no such file|readonly|authorization/i.test(message)) {
    return new AppError("source_unknown_database");
  }
  if (/locked|busy/i.test(message)) {
    return new AppError("source_row_busy");
  }
  if (/constraint|unique|not null|check/i.test(message)) {
    return new AppError("source_write_refused");
  }
  return new AppError("source_query_failed");
}
