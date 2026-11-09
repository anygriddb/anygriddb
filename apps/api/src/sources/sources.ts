/**
 * Declaring sources (ADR 0026): instance administrators only, on an
 * allowed host, signed in with a dedicated account over verified TLS. A
 * source is saved only once a connection to it succeeded.
 */
import { AppError, type SourceInput, type SourceUpdate } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { decryptSecret, encryptSecret } from "../auth/crypto.js";
import { withAudit } from "../data/audit-context.js";
import { isForeignKeyViolation } from "../data/pg-error.js";
import { isUniqueViolation } from "../data/schema-ops.js";
import { checkPostgres } from "./postgres.js";
import { checkMysql } from "./mysql.js";
import { checkSqlServer } from "./sqlserver.js";
import { introspectSqlServer } from "./sqlserver-schema.js";
import { introspectMysql } from "./mysql-schema.js";
import { introspectPostgres } from "./postgres-schema.js";
import type {
  SourceCheck,
  SourceConnection,
  SourceSettings,
  SourceTable,
} from "./types.js";

export type SourceDeps = {
  db: Database;
  key: Buffer;
  settings: SourceSettings;
};

type SourceRow = Awaited<ReturnType<typeof loadSource>>;

/** A source as administrators see it: never its password. */
export function publicSource(row: SourceRow) {
  return {
    id: row.id,
    name: row.name,
    engine: row.engine,
    host: row.host,
    port: row.port,
    database: row.database,
    username: row.username,
    tlsCa: row.tlsCa,
    connectionLimit: row.connectionLimit,
    queryTimeoutMs: row.queryTimeoutMs,
    timeZone: row.timeZone,
    sideSchema: row.sideSchema,
    serverVersion: row.serverVersion,
    checkedAt: row.checkedAt,
    passwordChangedAt: row.passwordChangedAt,
    createdAt: row.createdAt,
  };
}

async function loadSource(db: Database, id: string) {
  const row = await db
    .selectFrom("sources")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();
  if (!row) throw new AppError("unknown_source");
  return row;
}

export async function listSources(db: Database) {
  const rows = await db
    .selectFrom("sources")
    .selectAll()
    .orderBy("name")
    .execute();
  return rows.map(publicSource);
}

/** Connects as every later read will, or says why it cannot. */
export async function checkConnection(
  settings: SourceSettings,
  source: SourceConnection,
): Promise<SourceCheck> {
  if (!settings.allows(source.host)) {
    throw new AppError("source_host_not_allowed", source.host);
  }
  const options = { allowPlaintext: settings.allowPlaintext };
  switch (source.engine) {
    case "postgres":
      return checkPostgres(source, options);
    case "mysql":
    case "mariadb":
      return checkMysql(source, options);
    case "sqlserver":
      return checkSqlServer(source, options);
    default:
      throw new AppError("source_engine_unsupported", source.engine);
  }
}

function connectionOf(input: SourceInput): SourceConnection {
  return {
    engine: input.engine,
    host: input.host,
    port: input.port,
    database: input.database,
    username: input.username,
    password: input.password,
    tlsCa: input.tlsCa ?? null,
    queryTimeoutMs: input.queryTimeoutMs,
  };
}

/** Tries a source before it is saved. */
export function testSource(
  deps: SourceDeps,
  input: SourceInput,
): Promise<SourceCheck> {
  return checkConnection(deps.settings, connectionOf(input));
}

export async function createSource(
  deps: SourceDeps,
  actorId: string,
  input: SourceInput,
) {
  const checked = await testSource(deps, input);
  const sealed = encryptSecret(input.password, deps.key);
  try {
    const row = await withAudit(
      deps.db,
      { userId: actorId, source: "web" },
      (tx) =>
        tx
          .insertInto("sources")
          .values({
            name: input.name,
            engine: input.engine,
            host: input.host,
            port: input.port,
            database: input.database,
            username: input.username,
            passwordCiphertext: sealed.ciphertext,
            passwordNonce: sealed.nonce,
            tlsCa: input.tlsCa ?? null,
            connectionLimit: input.connectionLimit,
            queryTimeoutMs: input.queryTimeoutMs,
            timeZone: input.timeZone,
            sideSchema: input.sideSchema ?? null,
            serverVersion: checked.serverVersion,
            checkedAt: new Date(),
            createdBy: actorId,
          })
          .returningAll()
          .executeTakeFirstOrThrow(),
    );
    return publicSource(row);
  } catch (error) {
    if (isUniqueViolation(error)) throw new AppError("source_already_exists");
    throw error;
  }
}

/**
 * Changes a source. Its connection is checked again with the new values;
 * a password left out stays the stored one, and is replaced only whole.
 */
export async function updateSource(
  deps: SourceDeps,
  actorId: string,
  patch: SourceUpdate,
) {
  const row = await loadSource(deps.db, patch.id);
  const password =
    patch.password ??
    decryptSecret(row.passwordCiphertext, row.passwordNonce, deps.key);
  const next: SourceInput = {
    name: patch.name ?? row.name,
    engine: patch.engine ?? row.engine,
    host: patch.host ?? row.host,
    port: patch.port ?? row.port,
    database: patch.database ?? row.database,
    username: patch.username ?? row.username,
    password,
    tlsCa: patch.tlsCa === undefined ? row.tlsCa : patch.tlsCa,
    connectionLimit: patch.connectionLimit ?? row.connectionLimit,
    queryTimeoutMs: patch.queryTimeoutMs ?? row.queryTimeoutMs,
    timeZone: patch.timeZone ?? row.timeZone,
    sideSchema:
      patch.sideSchema === undefined ? row.sideSchema : patch.sideSchema,
  };
  const checked = await testSource(deps, next);
  const sealed = patch.password
    ? encryptSecret(patch.password, deps.key)
    : undefined;
  try {
    const updated = await withAudit(
      deps.db,
      { userId: actorId, source: "web" },
      (tx) =>
        tx
          .updateTable("sources")
          .set({
            name: next.name,
            engine: next.engine,
            host: next.host,
            port: next.port,
            database: next.database,
            username: next.username,
            tlsCa: next.tlsCa ?? null,
            connectionLimit: next.connectionLimit,
            queryTimeoutMs: next.queryTimeoutMs,
            timeZone: next.timeZone,
            sideSchema: next.sideSchema ?? null,
            serverVersion: checked.serverVersion,
            checkedAt: new Date(),
            updatedAt: new Date(),
            ...(sealed
              ? {
                  passwordCiphertext: sealed.ciphertext,
                  passwordNonce: sealed.nonce,
                  passwordChangedAt: new Date(),
                }
              : {}),
          })
          .where("id", "=", patch.id)
          .returningAll()
          .executeTakeFirstOrThrow(),
    );
    return publicSource(updated);
  } catch (error) {
    if (isUniqueViolation(error)) throw new AppError("source_already_exists");
    throw error;
  }
}

/** The decrypted connection of a saved source, for the server's own use. */
function storedConnection(deps: SourceDeps, row: SourceRow): SourceConnection {
  return {
    engine: row.engine,
    host: row.host,
    port: row.port,
    database: row.database,
    username: row.username,
    password: decryptSecret(
      row.passwordCiphertext,
      row.passwordNonce,
      deps.key,
    ),
    tlsCa: row.tlsCa,
    queryTimeoutMs: row.queryTimeoutMs,
  };
}

/** The tables and views a source's account may read, and their columns. */
export async function sourceTables(
  deps: SourceDeps,
  id: string,
): Promise<SourceTable[]> {
  const row = await loadSource(deps.db, id);
  const connection = storedConnection(deps, row);
  if (!deps.settings.allows(connection.host)) {
    throw new AppError("source_host_not_allowed", connection.host);
  }
  const options = { allowPlaintext: deps.settings.allowPlaintext };
  switch (connection.engine) {
    case "postgres":
      return introspectPostgres(connection, options);
    case "mysql":
    case "mariadb":
      return introspectMysql(connection, options);
    case "sqlserver":
      return introspectSqlServer(connection, options);
    default:
      throw new AppError("source_engine_unsupported", connection.engine);
  }
}

export type Exposure = {
  baseId: string;
  tableId: string;
  /** The writes an administrator enabled there (ADR 0006). */
  writes: { update: boolean; insert: boolean; delete: boolean };
  /** How changes made elsewhere are watched (ADR 0031), if they are. */
  watch: {
    method: "column" | "change_tracking";
    column: string | null;
    intervalSeconds: number;
    checkedAt: Date | null;
    changedAt: Date | null;
    changes: number;
    errorCode: string | null;
  } | null;
  /** Read from a copy refreshed every `intervalMinutes` (ADR 0034). */
  sync: {
    intervalMinutes: number;
    syncedAt: Date | null;
    rows: number | null;
    durationMs: number | null;
    changes: number;
    errorCode: string | null;
  } | null;
};

/** Where each table of a source shows, by `schema.name`. */
export async function exposedIn(
  db: Database,
  sourceId: string,
): Promise<Map<string, Exposure[]>> {
  const rows = await db
    .selectFrom("dataTables as t")
    .leftJoin("externalWatches as w", "w.tableId", "t.id")
    .leftJoin("externalSyncs as y", "y.tableId", "t.id")
    .select([
      "t.id",
      "t.baseId",
      "t.externalSchema",
      "t.externalName",
      "t.externalUpdate",
      "t.externalInsert",
      "t.externalDelete",
      "w.method",
      "w.columnName",
      "w.intervalSeconds",
      "w.checkedAt",
      "w.changedAt",
      "w.changes",
      "w.errorCode",
      "y.intervalMinutes as syncInterval",
      "y.syncedAt",
      "y.rowCount",
      "y.durationMs",
      "y.changes as syncChanges",
      "y.errorCode as syncError",
    ])
    .where("t.sourceId", "=", sourceId)
    .where("t.deletedAt", "is", null)
    .execute();
  const found = new Map<string, Exposure[]>();
  for (const row of rows) {
    const key = `${row.externalSchema ?? ""}.${row.externalName ?? ""}`;
    found.set(key, [
      ...(found.get(key) ?? []),
      {
        baseId: row.baseId,
        tableId: row.id,
        writes: {
          update: row.externalUpdate,
          insert: row.externalInsert,
          delete: row.externalDelete,
        },
        // How changes made elsewhere are told, and what the last check found.
        watch: row.method
          ? {
              method: row.method,
              column: row.columnName,
              intervalSeconds: row.intervalSeconds ?? 30,
              checkedAt: row.checkedAt,
              changedAt: row.changedAt,
              changes: row.changes ?? 0,
              errorCode: row.errorCode,
            }
          : null,
        // Read from a copy refreshed on a schedule (ADR 0034).
        sync:
          row.syncInterval !== null
            ? {
                intervalMinutes: row.syncInterval,
                syncedAt: row.syncedAt,
                rows: row.rowCount === null ? null : Number(row.rowCount),
                durationMs: row.durationMs,
                changes: row.syncChanges ?? 0,
                errorCode: row.syncError,
              }
            : null,
      },
    ]);
  }
  return found;
}

/** Connects to a saved source again, and records what it found. */
export async function recheckSource(deps: SourceDeps, id: string) {
  const row = await loadSource(deps.db, id);
  const checked = await checkConnection(
    deps.settings,
    storedConnection(deps, row),
  );
  // A check changes no setting: it is not a catalog change to audit.
  await deps.db
    .updateTable("sources")
    .set({ serverVersion: checked.serverVersion, checkedAt: new Date() })
    .where("id", "=", id)
    .execute();
  return checked;
}

export async function deleteSource(
  deps: SourceDeps,
  actorId: string,
  id: string,
): Promise<void> {
  let removed: Array<{ id: string }>;
  try {
    removed = await withAudit(
      deps.db,
      { userId: actorId, source: "web" },
      (tx) =>
        tx.deleteFrom("sources").where("id", "=", id).returning("id").execute(),
    );
  } catch (error) {
    // Tables of the source are still exposed, in a base or its trash.
    if (isForeignKeyViolation(error)) {
      throw new AppError("source_in_use", { cause: error });
    }
    throw error;
  }
  if (removed.length === 0) throw new AppError("unknown_source");
}
