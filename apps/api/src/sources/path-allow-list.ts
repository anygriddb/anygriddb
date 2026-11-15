import path from "node:path";
import { physicalPath } from "./physical-path.js";

/**
 * Directory prefixes where a SQLite source may point (ADR 0026). Set by the
 * operator in ANYGRIDDB_SOURCES_ALLOWED_PATHS as absolute paths, separated
 * by commas or colons. Empty allows none.
 */
export class PathAllowList {
  private readonly prefixes: string[] = [];
  readonly entries: readonly string[];

  constructor(spec: string | undefined) {
    const entries = (spec ?? "")
      .split(/[,:]+/)
      .map((entry) => entry.trim())
      .filter((entry) => entry !== "");
    for (const entry of entries) {
      if (entry.includes("\0")) {
        throw new Error(
          `ANYGRIDDB_SOURCES_ALLOWED_PATHS: invalid entry ${entry}`,
        );
      }
      if (!path.isAbsolute(entry)) {
        throw new Error(
          `ANYGRIDDB_SOURCES_ALLOWED_PATHS: path must be absolute ${entry}`,
        );
      }
      if (entry.split(/[/\\]/).some((segment) => segment === "..")) {
        throw new Error(
          `ANYGRIDDB_SOURCES_ALLOWED_PATHS: invalid entry ${entry}`,
        );
      }
      const normalized = normalizePrefix(entry);
      if (normalized.includes("..")) {
        throw new Error(
          `ANYGRIDDB_SOURCES_ALLOWED_PATHS: invalid entry ${entry}`,
        );
      }
      this.prefixes.push(normalized);
    }
    this.entries = entries;
  }

  allows(databasePath: string): boolean {
    const resolved = physicalPath(databasePath);
    return this.prefixes.some(
      (prefix) =>
        resolved === prefix || resolved.startsWith(`${prefix}${path.sep}`),
    );
  }
}

function normalizePrefix(entry: string): string {
  const physical = physicalPath(entry);
  if (physical === path.parse(physical).root) return physical;
  return physical.replace(/[/\\]+$/, "");
}
