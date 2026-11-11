import {
  AppError,
  type ColumnConfig,
  copyTable,
  type EngineCatalog,
  type EngineColumn,
  type EngineRelation,
  type EngineTable,
  type ExternalRelation,
  type FieldType,
  parseColumnConfig,
  parseServerVersion,
  SYNC_SCHEMA,
} from "@anygriddb/core";
import type { ColumnRow, Database, RelationRow, TableRow } from "@anygriddb/db";
import { sql } from "kysely";
import { liveColumn, liveTable } from "./live.js";

export type { ColumnRow, RelationRow, TableRow };

export type CatalogRows = {
  tables: TableRow[];
  columns: ColumnRow[];
  relations: RelationRow[];
  /** Each source the tables come from: its name, engine, and time zone. */
  sources: ReadonlyMap<
    string,
    {
      name: string;
      engine: string;
      timeZone: string;
      sideSchema: string | null;
      serverVersion?: string | null;
    }
  >;
  /** The version of AnyGridDB's own PostgreSQL, which reads its tables. */
  controlVersion?: readonly number[];
  /**
   * Client tables read from their copy (ADR 0034): the copy's columns and
   * types. Absent for a read that must reach the client's database.
   */
  syncs?: ReadonlyMap<string, ReadonlyArray<{ name: string; type: string }>>;
};

/** Parses a stored config, falling back to empty for a corrupt one so reads keep working. */
export function columnConfig(column: {
  fieldType: FieldType;
  config: unknown;
}): ColumnConfig {
  try {
    return parseColumnConfig(column.fieldType, column.config);
  } catch {
    return {};
  }
}

function isRelation(fieldType: FieldType): boolean {
  return (
    fieldType === "relation_one_to_many" ||
    fieldType === "relation_many_to_many"
  );
}

/**
 * The foreign key a one-to-many link column stands for, as stored: the
 * column itself on AnyGridDB's tables, the client's own foreign key on an
 * external table (kept in physical_name).
 */
function foreignKeyOf(column: ColumnRow, rows: CatalogRows): string {
  const table = rows.tables.find((item) => item.id === column.tableId);
  return table?.storage === "external" ? column.physicalName : column.name;
}

function relationFor(
  column: ColumnRow,
  config: ColumnConfig,
  rows: CatalogRows,
): EngineRelation | undefined {
  const own = rows.relations.find(
    (relation) => relation.fromColumnId === column.id,
  );
  if (!own) {
    return undefined;
  }
  if (config.inverseOf) {
    const forward = rows.relations.find(
      (relation) => relation.fromColumnId === config.inverseOf,
    );
    const forwardColumn = rows.columns.find(
      (item) => item.id === config.inverseOf,
    );
    if (!forward || !forwardColumn) {
      return undefined;
    }
    return own.kind === "one_to_many"
      ? {
          kind: "one_to_many",
          direction: "inverse",
          targetTableId: own.toTableId,
          fkColumn: foreignKeyOf(forwardColumn, rows),
        }
      : {
          kind: "many_to_many",
          direction: "inverse",
          targetTableId: own.toTableId,
          junction: forward.junctionName ?? undefined,
        };
  }
  return own.kind === "one_to_many"
    ? {
        kind: "one_to_many",
        direction: "forward",
        targetTableId: own.toTableId,
        fkColumn: foreignKeyOf(column, rows),
      }
    : {
        kind: "many_to_many",
        direction: "forward",
        targetTableId: own.toTableId,
        junction: own.junctionName ?? undefined,
      };
}

export function sortColumns(rows: readonly ColumnRow[]): ColumnRow[] {
  return [...rows].sort(
    (left, right) =>
      left.position - right.position || left.name.localeCompare(right.name),
  );
}

/** The engine of the source a client's table lives in. */
export function sourceEngine(
  rows: CatalogRows,
  sourceId: string | null,
): ExternalRelation["dialect"] {
  return sourceDialect(
    sourceId === null ? undefined : rows.sources.get(sourceId)?.engine,
  );
}

/** The SQL a source's engine reads; SQL Server comes with its driver. */
export function sourceDialect(
  engine: string | undefined,
): ExternalRelation["dialect"] {
  if (
    engine === "mysql" ||
    engine === "mariadb" ||
    engine === "postgres" ||
    engine === "sqlserver" ||
    engine === "oracle"
  ) {
    return engine;
  }
  throw new AppError("source_engine_unsupported", engine);
}

export function toEngineTable(table: TableRow, rows: CatalogRows): EngineTable {
  const own = sortColumns(
    rows.columns.filter((column) => column.tableId === table.id),
  );
  const copy = rows.syncs?.get(table.id);
  const live =
    table.storage === "external" &&
    table.sourceId &&
    table.externalSchema &&
    table.externalName &&
    table.externalKey
      ? {
          sourceId: table.sourceId,
          dialect: sourceDialect(rows.sources.get(table.sourceId)?.engine),
          schema: table.externalSchema,
          name: table.externalName,
          key: table.externalKey,
          // The fields AnyGridDB added live in the source's side schema.
          ...(table.externalSide && rows.sources.get(table.sourceId)?.sideSchema
            ? {
                side: {
                  schema: rows.sources.get(table.sourceId)?.sideSchema ?? "",
                  name: table.externalSide,
                },
              }
            : {}),
        }
      : undefined;
  // A synced table reads its copy, in AnyGridDB's PostgreSQL (ADR 0034).
  const copied = copy
    ? new Map(copy.map((item) => [item.name, item.type]))
    : null;
  const external =
    live && copied
      ? {
          sourceId: live.sourceId,
          dialect: "postgres" as const,
          schema: SYNC_SCHEMA,
          name: copyTable(table.id),
          key: live.key,
          synced: true,
        }
      : live;
  const engineColumns: EngineColumn[] = own.map((column) => {
    const config = columnConfig(column);
    const relation = isRelation(column.fieldType)
      ? relationFor(column, config, rows)
      : undefined;
    return {
      id: column.id,
      name: column.name,
      label: column.label,
      fieldType: column.fieldType,
      config,
      ...(relation ? { relation } : {}),
      // A stored client column reads under its own name; computed fields
      // and links have none.
      ...(external && copied && column.externalType !== null
        ? {
            // The copy stores each field in AnyGridDB's own type, in UTC.
            physical: {
              name: column.physicalName,
              type: copied.get(column.physicalName) ?? column.externalType,
              zone: "UTC",
              ...(copied.has(column.physicalName) ? {} : { missing: true }),
            },
          }
        : external && column.externalType !== null
          ? {
              physical: column.externalSide
                ? // AnyGridDB writes its own dates and times in UTC: in the
                  // side table, or in its own database where the field was
                  // made without one (ADR 0046). The field says which.
                  {
                    name: column.physicalName,
                    type: column.externalType,
                    zone: "UTC",
                    ...(column.externalControlPlane
                      ? { controlPlane: true }
                      : { side: true }),
                  }
                : {
                    name: column.physicalName,
                    type: column.externalType,
                    zone:
                      rows.sources.get(external.sourceId)?.timeZone ?? "UTC",
                  },
            }
          : {}),
    };
  });
  const primary = own.find((column) => column.isPrimary);
  // The server that reads the rows: the client's for a live table,
  // AnyGridDB's for its own tables and for copies.
  const serverVersion =
    live && !copied
      ? parseServerVersion(rows.sources.get(live.sourceId)?.serverVersion)
      : rows.controlVersion;
  return {
    id: table.id,
    storage: table.storage,
    physicalName: table.physicalName,
    ...(external ? { external } : {}),
    columns: engineColumns,
    ...(primary ? { primaryColumn: primary.name } : {}),
    ...(serverVersion ? { serverVersion } : {}),
  };
}

/** AnyGridDB's PostgreSQL version, read once: it changes only with a restart. */
let control: Promise<number[] | undefined> | undefined;

function controlVersion(db: Database): Promise<number[] | undefined> {
  control ??= sql<{
    version: string;
  }>`select current_setting('server_version') as version`
    .execute(db)
    .then((result) => parseServerVersion(result.rows[0]?.version))
    .catch(() => {
      control = undefined;
      return undefined;
    });
  return control;
}

/** Engine view of one table plus every table its links reach. */
export function assembleEngine(
  tableId: string,
  rows: CatalogRows,
  readable: (tableId: string) => boolean,
): EngineCatalog {
  const table = rows.tables.find((item) => item.id === tableId);
  if (!table) {
    throw new AppError("unknown_table");
  }
  const map = new Map<string, EngineTable>();
  for (const item of rows.tables) {
    map.set(item.id, toEngineTable(item, rows));
  }
  const own = map.get(table.id);
  if (!own) {
    throw new AppError("unknown_table");
  }
  return { table: own, tables: map, readable };
}

/**
 * Loads the catalog rows a read of `tableIds` needs: the tables, their
 * columns and links, and the tables those links reach, one level deep.
 */
export async function loadCatalogRows(
  db: Database,
  tableIds: readonly string[],
  options: { live?: boolean } = {},
): Promise<CatalogRows> {
  if (tableIds.length === 0) {
    return { tables: [], columns: [], relations: [], sources: new Map() };
  }
  const tableRows = await db
    .selectFrom("dataTables")
    .selectAll()
    .where("id", "in", [...tableIds])
    .where(liveTable())
    .execute();
  const liveIds = tableRows.map((table) => table.id);
  const columnRows =
    liveIds.length === 0
      ? []
      : await db
          .selectFrom("dataColumns")
          .selectAll()
          .where("tableId", "in", liveIds)
          .where(liveColumn())
          .orderBy("position", "asc")
          .execute();
  const ownRelations =
    columnRows.length === 0
      ? []
      : await db
          .selectFrom("relations")
          .selectAll()
          .where(
            "fromColumnId",
            "in",
            columnRows.map((column) => column.id),
          )
          .execute();
  const linked = [
    ...new Set(
      ownRelations
        .map((relation) => relation.toTableId)
        .filter((id) => !liveIds.includes(id)),
    ),
  ];
  const linkedTables =
    linked.length === 0
      ? []
      : await db
          .selectFrom("dataTables")
          .selectAll()
          .where("id", "in", linked)
          .where(liveTable())
          .execute();
  const linkedIds = linkedTables.map((table) => table.id);
  const linkedColumns =
    linkedIds.length === 0
      ? []
      : await db
          .selectFrom("dataColumns")
          .selectAll()
          .where("tableId", "in", linkedIds)
          .where(liveColumn())
          .execute();
  const linkedRelations =
    linkedColumns.length === 0
      ? []
      : await db
          .selectFrom("relations")
          .selectAll()
          .where(
            "fromColumnId",
            "in",
            linkedColumns.map((column) => column.id),
          )
          .execute();
  const allColumns = [...columnRows, ...linkedColumns];
  const allRelations = [...ownRelations, ...linkedRelations];
  const missingForward = allColumns
    .map((column) => columnConfig(column).inverseOf)
    .filter(
      (id): id is string =>
        typeof id === "string" &&
        !allColumns.some((column) => column.id === id),
    );
  if (missingForward.length > 0) {
    const forwardColumns = await db
      .selectFrom("dataColumns")
      .selectAll()
      .where("id", "in", missingForward)
      .where(liveColumn())
      .execute();
    const forwardRelations = await db
      .selectFrom("relations")
      .selectAll()
      .where("fromColumnId", "in", missingForward)
      .execute();
    allColumns.push(...forwardColumns);
    allRelations.push(...forwardRelations);
  }
  const tables = [...tableRows, ...linkedTables];
  const sourceIds = [
    ...new Set(
      tables
        .map((table) => table.sourceId)
        .filter((id): id is string => id !== null),
    ),
  ];
  const sources =
    sourceIds.length === 0
      ? []
      : await db
          .selectFrom("sources")
          .select([
            "id",
            "name",
            "engine",
            "timeZone",
            "sideSchema",
            "serverVersion",
          ])
          .where("id", "in", sourceIds)
          .execute();
  // Tables with a copy are read from it, unless a refresh reads them live.
  const externalIds = tables
    .filter((table) => table.storage === "external")
    .map((table) => table.id);
  const syncs =
    options.live || externalIds.length === 0
      ? []
      : await db
          .selectFrom("externalSyncs")
          .select(["tableId", "columns"])
          .where("tableId", "in", externalIds)
          .where("columns", "is not", null)
          .execute();
  const control = await controlVersion(db);
  return {
    tables,
    columns: allColumns,
    relations: allRelations,
    ...(control ? { controlVersion: control } : {}),
    sources: new Map(sources.map((source) => [source.id, source])),
    syncs: new Map(
      syncs.map((sync) => [
        sync.tableId,
        (sync.columns ?? []) as Array<{ name: string; type: string }>,
      ]),
    ),
  };
}

export async function loadEngine(
  db: Database,
  tableId: string,
  readable: (tableId: string) => boolean,
  options: { live?: boolean } = {},
): Promise<{ engine: EngineCatalog; rows: CatalogRows }> {
  const rows = await loadCatalogRows(db, [tableId], options);
  return { engine: assembleEngine(tableId, rows, readable), rows };
}
