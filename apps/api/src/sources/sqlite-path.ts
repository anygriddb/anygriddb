import path from "node:path";
import { AppError } from "@anygriddb/core";
import type { PathAllowList } from "./path-allow-list.js";
import { physicalPath } from "./physical-path.js";

export type SqlitePathAccess = {
  paths: PathAllowList;
  /** When false, `:memory:` is refused (production and default). */
  allowMemory: boolean;
};

/** Validates the database field of a SQLite source before opening the file. */
export function resolveSqliteDatabase(
  raw: string,
  access: SqlitePathAccess,
): string {
  const database = raw.trim();
  if (database === "" || database.includes("\0")) {
    throw new AppError("source_unknown_database");
  }
  if (database === ":memory:") {
    if (!access.allowMemory) {
      throw new AppError("source_path_not_allowed", database);
    }
    return database;
  }
  if (!path.isAbsolute(database)) {
    throw new AppError("source_path_not_allowed", database);
  }
  const segments = database.split(/[/\\]/);
  if (segments.some((segment) => segment === "..")) {
    throw new AppError("source_path_not_allowed", database);
  }
  // Follow symlinks so a link under an allowed prefix cannot open a file
  // the operator did not name (path.resolve alone is not enough).
  const resolved = physicalPath(database);
  if (!access.paths.allows(resolved)) {
    throw new AppError("source_path_not_allowed", resolved);
  }
  return resolved;
}
