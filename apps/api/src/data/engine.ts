import {
  AppError,
  type ColumnConfig,
  copyTable,
  type EngineCatalog,
  type EngineColumn,
  type EngineRelation,
  type EngineTable,
  type ExternalRelation,
  type SourceEngine,
  type FieldType,
  isCopySourceEngine,
  parseColumnConfig,
  parseServerVersion,
  SYNC_SCHEMA,
} from "@anygriddb/core";
import type { ColumnRow, Database, RelationRow, TableRow } from "@anygriddb/db";
import { sql } from "kysely";
import { liveColumn, liveTable } from "./live.js";

export type { ColumnRow, TableRow };

export type CatalogRows = {
  tables: TableRow[];
  columns: ColumnRow[];
  relations: RelationRow[];
  /** Each source the tables come from: its name, engine, host, and time zone. */
  sources: ReadonlyMap<
    string,
    {
      name: string;
      engine: string;
      /** Hosts the operator's allow list is checked against. */
      host: string;
      replicaHost: string | null;
      replicaPort: number | null;
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
  /**
   * The keys of each table's states in its circuit's order, for the tables
   * whose rows a field of their state reads (ADR 0133).
   */
  states?: ReadonlyMap<string, readonly string[]>;
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
function foreignKeyOf(column: ColumnRow, lookup: CatalogLookup): string {
  const table = lookup.tables.get(column.tableId);
  return table?.storage === "external" ? column.physicalName : column.name;
}

function relationFor(
  column: ColumnRow,
  config: ColumnConfig,
  lookup: CatalogLookup,
): EngineRelation | undefined {
  const own = lookup.relations.get(column.id);
  if (!own) {
    return undefined;
  }
  if (config.inverseOf) {
    const forward = lookup.relations.get(config.inverseOf);
    const forwardColumn = lookup.columns.get(config.inverseOf);
    if (!forward || !forwardColumn) {
      return undefined;
    }
    return own.kind === "one_to_many"
      ? {
          kind: "one_to_many",
          direction: "inverse",
          targetTableId: own.toTableId,
          fkColumn: foreignKeyOf(forwardColumn, lookup),
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
        fkColumn: foreignKeyOf(column, lookup),
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

/** The engine of the source a client's table lives in, as people know it. */
export function sourceEngine(
  rows: CatalogRows,
  sourceId: string | null,
): SourceEngine {
  const engine =
    sourceId === null ? undefined : rows.sources.get(sourceId)?.engine;
  return isCopySourceEngine(engine) ? engine : sourceDialect(engine);
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

function toEngineTable(
  table: TableRow,
  rows: CatalogRows,
  lookup: CatalogLookup,
): EngineTable {
  const own = sortColumns(lookup.columnsOf.get(table.id) ?? []);
  const copy = rows.syncs?.get(table.id);
  const engine =
    table.sourceId === null
      ? undefined
      : rows.sources.get(table.sourceId)?.engine;
  // A store that speaks no SQL has only its copy (ADR 0088): a refresh
  // reads the store itself, and everything else what the copy holds.
  const copyOnly = isCopySourceEngine(engine);
  const live =
    table.storage === "external" &&
    table.sourceId &&
    table.externalSchema &&
    table.externalName &&
    table.externalKey
      ? {
          sourceId: table.sourceId,
          dialect: copyOnly ? ("postgres" as const) : sourceDialect(engine),
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
    live && (copied || copyOnly)
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
      ? relationFor(column, config, lookup)
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
    live && !copied && !copyOnly
      ? parseServerVersion(rows.sources.get(live.sourceId)?.serverVersion)
      : rows.controlVersion;
  return {
    id: table.id,
    storage: table.storage,
    physicalName: table.physicalName,
    ...(external ? { external } : {}),
    columns: engineColumns,
    ...(primary ? { primaryColumn: primary.name } : {}),
    ...(rows.states?.has(table.id)
      ? { states: rows.states.get(table.id) ?? [] }
      : {}),
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

/** The catalog's rows by what they are looked up by. */
export type CatalogLookup = {
  tables: ReadonlyMap<string, TableRow>;
  columns: ReadonlyMap<string, ColumnRow>;
  columnsOf: ReadonlyMap<string, readonly ColumnRow[]>;
  /** A link column's relation, by that column's id. */
  relations: ReadonlyMap<string, RelationRow>;
};

/** The same, and every table as the read engine takes it. */
export type CatalogIndex = CatalogLookup & {
  engineTables: ReadonlyMap<string, EngineTable>;
};

export function lookupCatalog(rows: CatalogRows): CatalogLookup {
  const tables = new Map<string, TableRow>();
  for (const table of rows.tables) {
    if (!tables.has(table.id)) tables.set(table.id, table);
  }
  const columns = new Map<string, ColumnRow>();
  const columnsOf = new Map<string, ColumnRow[]>();
  for (const column of rows.columns) {
    if (!columns.has(column.id)) columns.set(column.id, column);
    const own = columnsOf.get(column.tableId);
    if (own) own.push(column);
    else columnsOf.set(column.tableId, [column]);
  }
  const relations = new Map<string, RelationRow>();
  for (const relation of rows.relations) {
    if (!relations.has(relation.fromColumnId)) {
      relations.set(relation.fromColumnId, relation);
    }
  }
  return { tables, columns, columnsOf, relations };
}

/**
 * Every table of `rows`, once. What reads many tables of one catalog builds
 * this once and hands it to each `assembleEngine`, whose cost is then the
 * size of the catalog and not its square.
 */
export function indexCatalog(rows: CatalogRows): CatalogIndex {
  const lookup = lookupCatalog(rows);
  const engineTables = new Map<string, EngineTable>();
  for (const table of lookup.tables.values()) {
    engineTables.set(table.id, toEngineTable(table, rows, lookup));
  }
  return { ...lookup, engineTables };
}

/** Engine view of one table plus every table its links reach. */
export function assembleEngine(
  tableId: string,
  rows: CatalogRows,
  readable: (tableId: string) => boolean,
  index: CatalogIndex = indexCatalog(rows),
): EngineCatalog {
  const own = index.engineTables.get(tableId);
  if (!own) {
    throw new AppError("unknown_table");
  }
  return { table: own, tables: index.engineTables, readable };
}

/**
 * How many links a read follows from its tables: as deep as the compiler
 * follows a chain of computed fields.
 */
const MAX_HOPS = 15;

const COMPUTED_TYPES: ReadonlySet<string> = new Set([
  "formula",
  "lookup",
  "rollup",
]);

/**
 * Loads the catalog rows a read of `tableIds` needs: the tables, their
 * columns and links, and the tables those links reach. A table reached
 * that way has its own links followed only where something reads through
 * them: one of its computed fields, or a lookup of the link itself. A
 * lookup of a lookup then finds its table, and a read of a table whose
 * neighbours compute nothing loads no more than it did.
 */
/** The keys of each table's states, in its circuit's order. */
async function circuitOrder(
  db: Database,
  tableIds: readonly string[],
): Promise<ReadonlyMap<string, readonly string[]>> {
  if (tableIds.length === 0) return new Map();
  const rows = await db
    .selectFrom("statusStates as s")
    .innerJoin("statusCircuits as c", "c.id", "s.circuitId")
    .select(["c.tableId", "s.key"])
    .where("c.tableId", "in", [...new Set(tableIds)])
    .orderBy("c.tableId")
    .orderBy("s.position")
    .execute();
  const order = new Map<string, string[]>();
  for (const row of rows) {
    if (row.tableId === null) continue;
    const keys = order.get(row.tableId) ?? [];
    keys.push(row.key);
    order.set(row.tableId, keys);
  }
  return order;
}

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
  const seen = new Set(liveIds);
  const linkedTables: typeof tableRows = [];
  const allColumns = [...columnRows];
  const allRelations = [...ownRelations];
  let followed = ownRelations;
  for (let hop = 0; hop < MAX_HOPS; hop += 1) {
    const linked = [
      ...new Set(
        followed
          .map((relation) => relation.toTableId)
          .filter((id) => !seen.has(id)),
      ),
    ];
    if (linked.length === 0) break;
    for (const id of linked) seen.add(id);
    const reached = await db
      .selectFrom("dataTables")
      .selectAll()
      .where("id", "in", linked)
      .where(liveTable())
      .execute();
    if (reached.length === 0) break;
    const reachedColumns = await db
      .selectFrom("dataColumns")
      .selectAll()
      .where(
        "tableId",
        "in",
        reached.map((table) => table.id),
      )
      .where(liveColumn())
      .execute();
    const reachedRelations =
      reachedColumns.length === 0
        ? []
        : await db
            .selectFrom("relations")
            .selectAll()
            .where(
              "fromColumnId",
              "in",
              reachedColumns.map((column) => column.id),
            )
            .execute();
    linkedTables.push(...reached);
    allColumns.push(...reachedColumns);
    allRelations.push(...reachedRelations);
    // What reads through a link of these tables: a computed field of the
    // table itself, or a lookup, further up, of the link's own field.
    const computing = new Set(
      reachedColumns
        .filter((column) => COMPUTED_TYPES.has(column.fieldType))
        .map((column) => column.tableId),
    );
    const targeted = new Set(
      allColumns
        .filter(
          (column) =>
            column.fieldType === "lookup" || column.fieldType === "rollup",
        )
        .map((column) => columnConfig(column).target)
        .filter((name): name is string => typeof name === "string"),
    );
    followed = reachedRelations.filter((relation) => {
      const link = reachedColumns.find(
        (column) => column.id === relation.fromColumnId,
      );
      return (
        link !== undefined &&
        (computing.has(link.tableId) || targeted.has(link.name))
      );
    });
  }
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
            "host",
            "replicaHost",
            "replicaPort",
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
  const states = await circuitOrder(
    db,
    allColumns
      .filter((column) => column.fieldType === "row_state")
      .map((column) => column.tableId),
  );
  return {
    tables,
    columns: allColumns,
    relations: allRelations,
    states,
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
