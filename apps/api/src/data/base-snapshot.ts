import {
  AppError,
  buildPlacesInRange,
  buildPositionsAfter,
  buildRowIdsBySeq,
  buildRowSeqs,
  buildSequenceAfter,
  buildSnapshotForeignKeys,
  buildSnapshotJunction,
  buildSnapshotKeys,
  buildSnapshotStatus,
  DEFAULT_ATTACHMENT_MAX_BYTES,
  type BaseSnapshot,
  baseSnapshotSchema,
  type CellValue,
  type ColumnDefinition,
  CREATABLE_TYPES,
  dashboardWidgetConfigSchema,
  deriveColumnName,
  type EngineCatalog,
  FAR_ROW_NUMBER,
  type FieldType,
  type FormulaExpr,
  type KeptRowStamp,
  type MadeNames,
  madeNames,
  MAX_SNAPSHOT_ARCHIVE_BYTES,
  MAX_SNAPSHOT_BYTES,
  MAX_SNAPSHOT_DASHBOARDS,
  MAX_SNAPSHOT_TABLES,
  MAX_SNAPSHOT_COMMENTS,
  MAX_SNAPSHOT_FILES,
  MAX_SNAPSHOT_FOLDERS,
  MAX_SNAPSHOT_LINE_BYTES,
  MAX_SNAPSHOT_LINK_PAIRS,
  MAX_SNAPSHOT_ROWS,
  MAX_SNAPSHOT_WIDGETS,
  normalizeViewConfig,
  ownSnapshotLineSchema,
  ROLLUP_FNS,
  type Given,
  type RollupFn,
  ROW_STATE_KEY,
  SNAPSHOT_ENTRY,
  SNAPSHOT_KEPT_VERSION,
  SNAPSHOT_KIND,
  SNAPSHOT_VERSION,
  type SnapshotDashboard,
  type SnapshotFile,
  type SnapshotFileRef,
  snapshotFileRefSchema,
  snapshotFilename,
  type SnapshotComment,
  snapshotCommentSchema,
  snapshotCommentsEntry,
  type SnapshotLine,
  snapshotLineCells,
  snapshotLineField,
  snapshotLineSchema,
  type SnapshotLink,
  snapshotRowCount,
  type SnapshotRole,
  type SnapshotRowState,
  snapshotRowStateSchema,
  snapshotRowsEntry,
  type SnapshotTable,
  widgetConfigOn,
  widgetSettings,
  writeSnapshotLine,
} from "@anygriddb/core";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { runStatement, type Database } from "@anygriddb/db";
import { sql } from "kysely";
import {
  aclColumnsOf,
  givenOf,
  type GivenColumns,
  MADE_COLUMNS,
  rowsOf,
  storedFieldAccess,
} from "./made-roles.js";
import {
  cleanFilename,
  loadAttachmentMeta,
  storeAttachment,
} from "../attachments.js";
import { runRows, withAudit } from "./audit-context.js";
import { insertComputed } from "./computed.js";
import { createDashboard, listDashboards, upsertWidget } from "./dashboards.js";
import { ERASED_USER_ID } from "./erasure.js";
import { MAX_COPY_ROWS, toCell } from "./data-ops.js";
import { loadEngine, sortColumns, type ColumnRow } from "./engine.js";
import { createFolder, listFolders, moveTableToFolder } from "./folders.js";
import { liveAttribution } from "./attributions.js";
import { liveBase, liveTable, liveView } from "./live.js";
import { postgresCode } from "./pg-error.js";
import { addRelation, setLinks } from "./relations.js";
import {
  baseCollaboratorIds,
  readPage,
  type RowRecord,
  writeColumns,
  type WriteContext,
} from "./rows.js";
import { insertNativeBatch } from "../services/rows.js";
import {
  addColumn,
  insertBase,
  insertTable,
  setPrimaryColumn,
} from "./schema-ops.js";
import { removeBase } from "./tables.js";
import type { FileStore } from "../files/index.js";
import { createView } from "./views.js";
import { ZipError, type ZipReader, ZipWriter } from "./zip.js";

const LINK_TYPES = new Set<FieldType>([
  "relation_one_to_many",
  "relation_many_to_many",
]);
const COMPUTED_TYPES = new Set<FieldType>(["lookup", "rollup"]);

/** Rows a snapshot reads, or links, at a time. */
const SNAPSHOT_PAGE = 1_000;
/** Rows a snapshot writes into a new table at a time. */
const IMPORT_BATCH = 500;
/** The targets one row of a version 3 line links to at most. */
const ROW_TARGETS = 500;
/** A sequence number as a line names it. */
const SEQ = /^[1-9]\d{0,18}$/;

function writeContext(
  userId: string,
  table: { id: string; physicalName: string; baseId: string },
): WriteContext {
  return {
    userId,
    tableId: table.id,
    physicalName: table.physicalName,
    baseId: table.baseId,
    reason: null,
    source: "snapshot",
  };
}

function isRollupFn(value: unknown): value is RollupFn {
  return (
    typeof value === "string" &&
    (ROLLUP_FNS as readonly string[]).includes(value)
  );
}

function creatable(fieldType: FieldType): ColumnDefinition["fieldType"] {
  const found = CREATABLE_TYPES.find((type) => type === fieldType);
  if (!found) throw new AppError("invalid_column");
  return found;
}

function definitionOf(column: ColumnRow): ColumnDefinition {
  const config = { ...(column.config ?? {}) };
  const expr = config.expr as FormulaExpr | undefined;
  delete config.expr;
  delete config.inverseOf;
  return {
    name: column.name,
    label: column.label,
    fieldType: creatable(column.fieldType),
    description: column.description ?? undefined,
    requireReason: column.requireReason,
    required: column.required,
    unique: column.isUnique,
    config,
    formula: column.fieldType === "formula" ? expr : undefined,
  };
}

/** Stable key from a table name for cross-references inside the file. */
function tableKey(name: string, used: Set<string>): string {
  const base = deriveColumnName(name, new Set()).slice(0, 48) || "table";
  let key = base;
  for (let n = 2; used.has(key); n += 1) {
    key = `${base}_${n}`.slice(0, 63);
  }
  used.add(key);
  return key;
}

function linkIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (item && typeof item === "object" && "id" in item) {
      return [String((item as { id: unknown }).id)];
    }
    return [];
  });
}

/** The attachments a snapshot's cells name, by key: what its archive holds. */
type SnapshotAttachments = Map<string, { name: string; size: number }>;

/**
 * The base's members with a role of their own, by email: a group's roles
 * stay with the instance that keeps the group.
 */
async function baseMembers(db: Database, baseId: string) {
  // One role of their own a person holds on a base (the index on
  // `attributions` keeps it so).
  const rows = await db
    .selectFrom("attributions as a")
    .innerJoin("users as u", "u.id", "a.userId")
    .leftJoin("madeRoles as m", "m.id", "a.madeRoleId")
    .select(["u.email", "a.role", ...MADE_COLUMNS])
    .where("a.scope", "=", "base")
    .where("a.scopeId", "=", baseId)
    .execute();
  return rows.flatMap((row) => {
    const role = snapshotRoleOf(givenOf(row));
    return role ? [{ email: row.email, role }] : [];
  });
}

/** A role as a snapshot carries it: a made role by its name and acts. */
function snapshotRoleOf(given: Given | null): SnapshotRole | null {
  if (given === null) return null;
  if (typeof given === "string") return given;
  if (given.permissions.length === 0) return null;
  return { name: given.name, permissions: [...given.permissions] };
}

function madeKey(role: { name: string; permissions: readonly string[] }) {
  const acts = [...role.permissions].sort((a, b) => a.localeCompare(b));
  return `${role.name.toLowerCase()}|${acts.join(",")}`;
}

/**
 * The made roles here that a snapshot's members name: one of that name
 * that gives exactly those permissions. Another gives that person nothing.
 */
async function madeRolesHere(
  db: Database,
  roles: readonly SnapshotRole[],
): Promise<Map<string, string>> {
  const wanted = roles.filter(
    (role): role is Exclude<SnapshotRole, string> => typeof role !== "string",
  );
  if (wanted.length === 0) return new Map();
  const here = await db
    .selectFrom("madeRoles")
    .select(["id", "name", "permissions"])
    .execute();
  return new Map(here.map((role) => [madeKey(role), role.id]));
}

/** The columns a snapshot's role is given back in, if it can be. */
function givenBack(
  role: SnapshotRole,
  here: ReadonlyMap<string, string>,
): GivenColumns | null {
  if (typeof role === "string") return { role, madeRoleId: null };
  const id = here.get(madeKey(role));
  return id ? { role: null, madeRoleId: id } : null;
}

type TableAccess = NonNullable<SnapshotTable["access"]>;

/**
 * Each person's own access to the base's tables, by email: a role given
 * on a table, and the row and field rules it carries (ADR 0131). A rule
 * that no longer reads hides every row, as it does in the grid.
 */
async function tablesAccess(
  db: Database,
  tableIds: readonly string[],
): Promise<Map<string, TableAccess>> {
  const found = new Map<string, Map<string, TableAccess[number]>>();
  if (tableIds.length === 0) return new Map();
  const entry = (tableId: string, email: string) => {
    const byEmail =
      found.get(tableId) ?? new Map<string, TableAccess[number]>();
    found.set(tableId, byEmail);
    const current = byEmail.get(email) ?? { email };
    byEmail.set(email, current);
    return current;
  };
  const roles = await db
    .selectFrom("attributions as a")
    .innerJoin("users as u", "u.id", "a.userId")
    .leftJoin("madeRoles as m", "m.id", "a.madeRoleId")
    .select([
      "a.scopeId as tableId",
      "u.email",
      "a.role",
      "a.rowFilter",
      "a.fieldAccess",
      ...MADE_COLUMNS,
    ])
    .where("a.scope", "=", "table")
    .where("a.scopeId", "in", tableIds)
    .execute();
  for (const row of roles) {
    const role = snapshotRoleOf(givenOf(row));
    if (!role || row.tableId === null) continue;
    const current = entry(row.tableId, row.email);
    current.role = role;
    const rows = rowsOf(row.rowFilter);
    if (rows) current.rowFilter = rows;
    const columns = aclColumnsOf(row.fieldAccess);
    if (columns) current.columns = columns;
  }
  return new Map(
    [...found].map(([tableId, byEmail]) => [tableId, [...byEmail.values()]]),
  );
}

/** What a restore point keeps of the groups' roles (ADR 0117). */
type KeptGroups = {
  base: NonNullable<BaseSnapshot["groups"]>;
  tables: Map<string, NonNullable<SnapshotTable["groups"]>>;
};

/**
 * Each group's role on the base and on its tables, with the rules a
 * table's carries, as a restore point keeps them: by the group's id, which
 * only this instance knows. One past its end gives nothing, and is left.
 */
async function keptGroups(
  db: Database,
  baseId: string,
  tableIds: readonly string[],
): Promise<KeptGroups> {
  const rows = await db
    .selectFrom("attributions as a")
    .leftJoin("madeRoles as m", "m.id", "a.madeRoleId")
    .select([
      "a.groupId",
      "a.scope",
      "a.scopeId",
      "a.role",
      "a.rowFilter",
      "a.fieldAccess",
      ...MADE_COLUMNS,
    ])
    .where("a.groupId", "is not", null)
    .where((eb) =>
      eb.or([
        eb.and([eb("a.scope", "=", "base"), eb("a.scopeId", "=", baseId)]),
        ...(tableIds.length > 0
          ? [
              eb.and([
                eb("a.scope", "=", "table"),
                eb("a.scopeId", "in", tableIds),
              ]),
            ]
          : []),
      ]),
    )
    .where(liveAttribution)
    .orderBy("a.groupId")
    .execute();
  const kept: KeptGroups = { base: [], tables: new Map() };
  for (const row of rows) {
    const role = snapshotRoleOf(givenOf(row));
    if (!role || row.groupId === null || row.scopeId === null) continue;
    if (row.scope === "base") {
      kept.base.push({ group: row.groupId, role });
      continue;
    }
    const rules = rowsOf(row.rowFilter);
    const columns = aclColumnsOf(row.fieldAccess);
    const list = kept.tables.get(row.scopeId) ?? [];
    list.push({
      group: row.groupId,
      role,
      ...(rules ? { rowFilter: rules } : {}),
      ...(columns ? { columns } : {}),
    });
    kept.tables.set(row.scopeId, list);
  }
  return kept;
}

/** A table as a snapshot reads it: its schema, and what its lines need. */
type SourceTable = {
  key: string;
  id: string;
  physicalName: string;
  engine: EngineCatalog;
  snapshot: SnapshotTable;
  /** Stored fields, written as a line's cells. */
  writable: string[];
  fileColumns: ReadonlySet<string>;
  userColumns: ReadonlySet<string>;
  /** Links from this table to a table of the snapshot, by field name. */
  links: Array<{ name: string; targetPhysical: string }>;
};

/**
 * What a base is made of: its own tables with their stored fields and
 * views, the links between them, and their lookups and rollups.
 */
async function describeBase(
  db: Database,
  baseId: string,
): Promise<{
  base: { name: string; description: string | null };
  tables: SourceTable[];
  links: SnapshotLink[];
  computed: BaseSnapshot["computed"];
  folders: Array<{ name: string }>;
  dashboards: SnapshotDashboard[];
}> {
  const base = await db
    .selectFrom("bases")
    .selectAll()
    .where("id", "=", baseId)
    .where(liveBase())
    .executeTakeFirst();
  if (!base) throw new AppError("unknown_base");

  const tableRows = await db
    .selectFrom("dataTables")
    .selectAll()
    .where("baseId", "=", baseId)
    // A snapshot holds AnyGridDB's own tables: a client's stay in its
    // database, and are exposed again from their source.
    .where("storage", "=", "native")
    .where(liveTable())
    .orderBy("position", "asc")
    .orderBy("createdAt", "asc")
    .execute();
  // Said before anything is written, whichever way the base is going out.
  if (tableRows.length > MAX_SNAPSHOT_TABLES) {
    throw new AppError("snapshot_too_many_tables");
  }
  if (tableRows.length === 0) throw new AppError("no_tables");

  // The folders the tables are kept in, in their order: every one of
  // them, or past what a snapshot lists, those that hold a table.
  const held = new Set(tableRows.map((table) => table.folderId));
  const everyFolder = await listFolders(db, [baseId]);
  const folders =
    everyFolder.length > MAX_SNAPSHOT_FOLDERS
      ? everyFolder.filter((folder) => held.has(folder.id))
      : everyFolder;
  const folderName = new Map(folders.map((folder) => [folder.id, folder.name]));

  const keys = new Set<string>();
  const idToKey = new Map<string, string>();
  const physicalOf = new Map<string, string>();
  for (const table of tableRows) {
    idToKey.set(table.id, tableKey(table.name, keys));
    physicalOf.set(table.id, table.physicalName);
  }

  const tables: SourceTable[] = [];
  const snapshotLinks: SnapshotLink[] = [];
  const computed: BaseSnapshot["computed"] = [];
  const emittedLinks = new Set<string>();
  const placed = new Map<string, PlacedTable>();

  for (const table of tableRows) {
    const key = idToKey.get(table.id) ?? tableKey(table.name, keys);
    const { engine, rows } = await loadEngine(db, table.id, () => true);
    const own = sortColumns(
      rows.columns.filter((column) => column.tableId === table.id),
    );
    const stored = own.filter(
      (column) =>
        !LINK_TYPES.has(column.fieldType) &&
        !COMPUTED_TYPES.has(column.fieldType),
    );
    const primary = own.find((column) => column.isPrimary)?.name;

    const viewRows = await db
      .selectFrom("views")
      .selectAll()
      .where("tableId", "=", table.id)
      .where(liveView())
      .orderBy("position", "asc")
      .orderBy("createdAt", "asc")
      .execute();
    // The views everyone has: one person's own stay with that person.
    const shared = viewRows.filter((view) => !view.ownerId);
    placed.set(table.id, {
      key,
      views: new Map(shared.map((view, rank) => [view.id, rank])),
    });

    const links: SourceTable["links"] = [];
    for (const column of own.filter((item) => LINK_TYPES.has(item.fieldType))) {
      const engineColumn = engine.table.columns.find(
        (item) => item.id === column.id,
      );
      const relation = engineColumn?.relation;
      if (!relation || relation.direction !== "forward") continue;
      const toKey = idToKey.get(relation.targetTableId);
      const targetPhysical = physicalOf.get(relation.targetTableId);
      if (!toKey || !targetPhysical) continue;
      const mark = `${key}:${column.name}`;
      if (emittedLinks.has(mark)) continue;
      emittedLinks.add(mark);
      const saved = rows.relations.find(
        (item) => item.fromColumnId === column.id,
      );
      const inverse = saved?.inverseColumnId
        ? rows.columns.find((item) => item.id === saved.inverseColumnId)
        : undefined;
      snapshotLinks.push({
        from: key,
        to: toKey,
        name: column.name,
        label: column.label,
        inverseLabel: inverse?.label ?? column.label,
        ...(inverse ? { inverseName: inverse.name } : {}),
        twoWay: inverse !== undefined,
        multiple: relation.kind === "many_to_many",
      });
      links.push({ name: column.name, targetPhysical });
    }

    for (const column of own.filter((item) =>
      COMPUTED_TYPES.has(item.fieldType),
    )) {
      const config = column.config ?? {};
      if (
        typeof config.relation !== "string" ||
        typeof config.target !== "string"
      ) {
        continue;
      }
      computed.push({
        table: key,
        name: column.name,
        label: column.label,
        relation: config.relation,
        target: config.target,
        fn: isRollupFn(config.fn) ? config.fn : undefined,
      });
    }

    const write = writeColumns(engine);
    const typed = (type: FieldType) =>
      new Set(
        write
          .filter((column) => column.fieldType === type)
          .map((column) => column.name),
      );
    tables.push({
      key,
      id: table.id,
      physicalName: table.physicalName,
      engine,
      snapshot: {
        key,
        name: table.name,
        description: table.description ?? undefined,
        // A folder in the trash holds no table: its tables went back to
        // the root when it was deleted.
        folder: table.folderId ? folderName.get(table.folderId) : undefined,
        columns: stored.map(definitionOf),
        primary,
        views: shared.map((view) => ({
          name: view.name,
          viewType: view.viewType,
          config: normalizeViewConfig(view.config, view.viewType),
        })),
      },
      writable: write.map((column) => column.name),
      fileColumns: typed("attachment"),
      userColumns: typed("user"),
      links,
    });
  }
  return {
    base: { name: base.name, description: base.description },
    tables,
    links: snapshotLinks,
    computed,
    folders: folders.map((folder) => ({ name: folder.name })),
    dashboards: await describeDashboards(db, baseId, placed),
  };
}

/** Where a snapshot keeps a table: its key, and its views by their rank. */
type PlacedTable = { key: string; views: ReadonlyMap<string, number> };

/**
 * The base's dashboards in their order, each widget naming the table it
 * reads by its key and its view by its rank there. A widget that reads
 * what the snapshot does not hold (a table that lives in a client's
 * database, a view only its author has) is left out and counted: under
 * its title, without its view, it would show another figure.
 */
async function describeDashboards(
  db: Database,
  baseId: string,
  tables: ReadonlyMap<string, PlacedTable>,
): Promise<SnapshotDashboard[]> {
  const boards = await listDashboards(db, baseId);
  if (boards.length === 0) return [];
  if (boards.length > MAX_SNAPSHOT_DASHBOARDS) {
    throw new AppError("too_large_snapshot");
  }
  const widgets = await db
    .selectFrom("dashboardWidgets")
    .selectAll()
    .where(
      "dashboardId",
      "in",
      boards.map((board) => board.id),
    )
    .orderBy("y", "asc")
    .orderBy("x", "asc")
    .orderBy("createdAt", "asc")
    .orderBy("id", "asc")
    .execute();
  const widgetsOf = new Map<string, typeof widgets>();
  for (const widget of widgets) {
    const listed = widgetsOf.get(widget.dashboardId);
    if (listed) listed.push(widget);
    else widgetsOf.set(widget.dashboardId, [widget]);
  }
  return boards.map((board) => {
    const kept: SnapshotDashboard["widgets"] = [];
    let left = 0;
    for (const widget of widgetsOf.get(board.id) ?? []) {
      const read = dashboardWidgetConfigSchema.safeParse({
        kind: widget.kind,
        config: widget.config,
      });
      const config = read.success ? read.data.config : undefined;
      const table = config ? tables.get(config.tableId) : undefined;
      const viewId = config && "viewId" in config ? config.viewId : undefined;
      const view = viewId === undefined ? undefined : table?.views.get(viewId);
      if (!config || !table || (viewId !== undefined && view === undefined)) {
        left += 1;
        continue;
      }
      kept.push({
        title: widget.title,
        kind: widget.kind,
        x: widget.x,
        y: widget.y,
        w: widget.w,
        h: widget.h,
        table: table.key,
        ...(view === undefined ? {} : { view }),
        config: widgetSettings(config),
      });
    }
    if (kept.length > MAX_SNAPSHOT_WIDGETS) {
      throw new AppError("too_large_snapshot");
    }
    return {
      name: board.name,
      ...(board.description ? { description: board.description } : {}),
      widgets: kept,
      ...(left > 0 ? { left } : {}),
    };
  });
}

/** The sequence numbers of some rows of a table, by their ids. */
async function seqsOf(
  db: Database,
  table: string,
  ids: readonly string[],
): Promise<Map<string, string>> {
  const seqs = new Map<string, string>();
  for (let start = 0; start < ids.length; start += MAX_SNAPSHOT_LINK_PAIRS) {
    const found = await runStatement(
      db,
      buildRowSeqs({
        table,
        ids: ids.slice(start, start + MAX_SNAPSHOT_LINK_PAIRS),
      }),
    );
    for (const row of found) seqs.set(String(row.id), String(row.seq));
  }
  return seqs;
}

/**
 * A table's rows as the lines of its entry, read a range of sequence
 * numbers at a time: each row's cells, its number and place, and the
 * numbers of the rows its links name and, with `keepState`, what the row
 * is. A row added or removed while it reads is written once or not at all,
 * never twice.
 */
async function* tableLines(
  db: Database,
  table: SourceTable,
  attachments: SnapshotAttachments,
  onRows: (count: number) => Promise<void>,
  keepState: boolean,
): AsyncGenerator<string> {
  const fields = [...table.writable, ...table.links.map((link) => link.name)];
  let after = "0";
  for (;;) {
    const keys = await runStatement(
      db,
      buildSnapshotKeys({
        table: table.physicalName,
        after,
        limit: SNAPSHOT_PAGE,
        state: keepState,
      }),
    );
    const last = keys.at(-1);
    if (!last) return;
    after = String(last.seq);
    const page = await readPage(
      db,
      table.engine,
      {
        rowIds: keys.map((key) => String(key.id)),
        fields,
        limit: keys.length,
      },
      { total: false },
    );
    const byId = new Map(page.rows.map((row) => [row.id, row]));
    const rows: Array<{
      source: RowRecord;
      seq: string;
      position: string;
      cells: Record<string, CellValue | string | undefined>;
      state?: SnapshotRowState;
    }> = [];
    for (const key of keys) {
      const source = byId.get(String(key.id));
      // Removed between the two reads.
      if (!source) continue;
      const cells: Record<string, CellValue | string | undefined> = {};
      for (const name of table.writable) cells[name] = toCell(source[name]);
      rows.push({
        source,
        seq: String(key.seq),
        position: String(key.position),
        cells,
        ...(keepState
          ? {
              state: snapshotRowStateSchema.parse({
                status: key.status,
                createdAt: key.createdAt,
                updatedAt: key.updatedAt,
                createdBy: key.createdBy,
                updatedBy: key.updatedBy,
              }),
            }
          : {}),
      });
    }
    await describeCells(
      db,
      table.id,
      rows.map((row) => row.cells) as NonNullable<SnapshotTable["rows"]>,
      {
        fileColumns: table.fileColumns,
        userColumns: table.userColumns,
        attachments,
      },
    );
    for (const link of table.links) {
      const targets = [
        ...new Set(rows.flatMap((row) => linkIds(row.source[link.name]))),
      ];
      const seqs =
        targets.length > 0
          ? await seqsOf(db, link.targetPhysical, targets)
          : new Map<string, string>();
      for (const row of rows) {
        const named = linkIds(row.source[link.name]).flatMap((id) => {
          const seq = seqs.get(id);
          return seq ? [seq] : [];
        });
        if (named.length > 0) row.cells[link.name] = named;
      }
    }
    for (const row of rows) {
      const line = writeSnapshotLine({
        seq: row.seq,
        position: row.position,
        cells: row.cells,
        state: row.state,
      });
      yield `${JSON.stringify(line)}\n`;
    }
    await onRows(rows.length);
  }
}

/** A row's id as a native table gives it. */
const ROW_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** An instant as the copy writes it: UTC, to the microsecond. */
const COMMENT_AT = (column: string) =>
  sql<string>`to_char(${sql.ref(column)} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** Whether any row of a table has a comment: none, no entry. */
async function hasComments(db: Database, tableId: string): Promise<boolean> {
  const found = await db
    .selectFrom("comments")
    .select("id")
    .where("tableId", "=", tableId)
    .limit(1)
    .executeTakeFirst();
  return found !== undefined;
}

/**
 * A table's comments as the lines of its entry in an instance's own copy
 * (ADR 0122): row by row, each row's in the order they were written, so
 * that a reply follows what it answers. A comment on a row the copy does
 * not hold, one in the trash, stays behind.
 */
async function* commentLines(
  db: Database,
  table: SourceTable,
  onComments: (count: number) => void,
): AsyncGenerator<string> {
  let after: { rowId: string; at: string; id: string } | undefined;
  for (;;) {
    let query = db
      .selectFrom("comments")
      .select([
        "id",
        "rowId",
        "parentId",
        "authorId",
        "body",
        "resolvedBy",
        COMMENT_AT("createdAt").as("createdAt"),
        COMMENT_AT("updatedAt").as("updatedAt"),
        COMMENT_AT("deletedAt").as("deletedAt"),
        COMMENT_AT("resolvedAt").as("resolvedAt"),
      ])
      .where("tableId", "=", table.id)
      .orderBy("rowId")
      .orderBy("createdAt")
      .orderBy("id")
      .limit(SNAPSHOT_PAGE);
    if (after) {
      const { rowId, at, id } = after;
      query = query.where(
        sql<boolean>`(row_id, created_at, id) > (${rowId}, ${at}::timestamptz, ${id}::uuid)`,
      );
    }
    const page = await query.execute();
    const last = page.at(-1);
    if (!last) return;
    after = { rowId: last.rowId, at: last.createdAt, id: last.id };
    const rowIds = [...new Set(page.map((comment) => comment.rowId))].filter(
      (id) => ROW_UUID.test(id),
    );
    const seqs =
      rowIds.length > 0
        ? await seqsOf(db, table.physicalName, rowIds)
        : new Map<string, string>();
    let count = 0;
    for (const comment of page) {
      const row = seqs.get(comment.rowId);
      if (!row) continue;
      const line: SnapshotComment = {
        id: comment.id,
        row,
        parent: comment.parentId,
        author: comment.authorId,
        body: comment.body,
        createdAt: comment.createdAt,
        updatedAt: comment.updatedAt,
        deletedAt: comment.deletedAt,
        resolvedAt: comment.resolvedAt,
        resolvedBy: comment.resolvedBy,
      };
      count += 1;
      yield `${JSON.stringify(snapshotCommentSchema.parse(line))}\n`;
    }
    onComments(count);
  }
}

/** A snapshot's JSON, refused past its size. */
function snapshotBytes(snapshot: BaseSnapshot): Buffer {
  const bytes = Buffer.from(`${JSON.stringify(snapshot)}\n`, "utf8");
  if (bytes.length > MAX_SNAPSHOT_BYTES) {
    throw new AppError("too_large_snapshot");
  }
  return bytes;
}

/** A snapshot written out: JSON bytes, or an archive in a local file. */
type PackedSnapshot =
  | { kind: "json"; bytes: Buffer; filename: string }
  | { kind: "zip"; path: string; size: number; filename: string };

export type WrittenSnapshot = {
  /** What the snapshot holds, its rows counted but read from its entries. */
  snapshot: BaseSnapshot;
  packed: PackedSnapshot;
  /** Rows written, all tables together. */
  rows: number;
  /** Files the snapshot's cells name. */
  files: number;
};

/**
 * Writes a portable snapshot of a base (version 3, ADR 0076): without data,
 * its schema and views as JSON; with data, a ZIP archive in `folder` whose
 * every table's rows are the lines of their own entry, deflated as they are
 * read, beside its members, the files its cells name, and `snapshot.json`.
 * Nothing but a page of rows is held in memory: a snapshot holds as many
 * rows as `maxRows` allows. `embedFiles: false` leaves the files out, for a
 * copy made inside the instance, which reads them from its store.
 * `keepRowState` writes version 4 (ADR 0117), each row with its dates,
 * authors, and status: for a copy that stays on this instance.
 */
export async function writeBaseSnapshot(
  db: Database,
  files: FileStore,
  baseId: string,
  input: {
    withData: boolean;
    folder: string;
    /** The most rows the snapshot holds, all tables together. */
    maxRows: number;
    embedFiles?: boolean;
    keepRowState?: boolean;
    onProgress?: (done: number, total: number | null) => Promise<void>;
  },
): Promise<WrittenSnapshot> {
  const described = await describeBase(db, baseId);
  const keepState = input.withData && input.keepRowState === true;
  const head = {
    kind: SNAPSHOT_KIND,
    version: keepState ? SNAPSHOT_KEPT_VERSION : SNAPSHOT_VERSION,
    exportedAt: new Date().toISOString(),
    base: {
      name: described.base.name,
      description: described.base.description ?? undefined,
    },
    links: described.links,
    computed: described.computed,
    // Named only when the base has some: without folders, the snapshot
    // is the one an instance that knows none reads.
    ...(described.folders.length > 0 ? { folders: described.folders } : {}),
    // Its dashboards, on the same terms.
    ...(described.dashboards.length > 0
      ? { dashboards: described.dashboards }
      : {}),
  };
  if (!input.withData) {
    const snapshot = baseSnapshotSchema.parse({
      ...head,
      tables: described.tables.map((table) => table.snapshot),
    });
    await input.onProgress?.(1, 1);
    return {
      snapshot,
      packed: {
        kind: "json",
        bytes: snapshotBytes(snapshot),
        filename: snapshotFilename(described.base.name),
      },
      rows: 0,
      files: 0,
    };
  }

  let total = 0;
  for (const table of described.tables) {
    const counted = await readPage(
      db,
      table.engine,
      { limit: 1, fields: [] },
      { total: true },
    );
    total += counted.total ?? 0;
  }
  if (total > input.maxRows) throw new AppError("snapshot_too_many_rows");

  const path = join(input.folder, "snapshot.zip");
  const writer = new ZipWriter(path);
  const attachments: SnapshotAttachments = new Map();
  let written = 0;
  await input.onProgress?.(0, total);
  try {
    const access = await tablesAccess(
      db,
      described.tables.map((table) => table.id),
    );
    // The instance's own copy keeps its groups' roles too, an empty list
    // saying there were none (a copy made before kept nothing of them).
    const groups = keepState
      ? await keptGroups(
          db,
          baseId,
          described.tables.map((table) => table.id),
        )
      : undefined;
    const tables: SnapshotTable[] = [];
    for (const table of described.tables) {
      let rowCount = 0;
      await writer.addDeflatedStream(
        snapshotRowsEntry(table.key),
        tableLines(
          db,
          table,
          attachments,
          async (count) => {
            rowCount += count;
            written += count;
            // Rows added while it reads count too.
            if (written > input.maxRows) {
              throw new AppError("snapshot_too_many_rows");
            }
            await input.onProgress?.(Math.min(written, total), total);
          },
          keepState,
        ),
      );
      // The instance's own copy brings its rows' comments along.
      let comments = 0;
      if (keepState && rowCount > 0 && (await hasComments(db, table.id))) {
        await writer.addDeflatedStream(
          snapshotCommentsEntry(table.key),
          commentLines(db, table, (count) => {
            comments += count;
            if (comments > MAX_SNAPSHOT_COMMENTS) {
              throw new AppError("too_large_snapshot");
            }
          }),
        );
      }
      const people = access.get(table.id);
      tables.push({
        ...table.snapshot,
        rowCount,
        ...(people?.length ? { access: people } : {}),
        ...(groups ? { groups: groups.tables.get(table.id) ?? [] } : {}),
        ...(comments > 0 ? { comments } : {}),
      });
    }
    if (attachments.size > MAX_SNAPSHOT_FILES) {
      throw new AppError("too_large_snapshot");
    }
    const listed: SnapshotFile[] = [];
    if (input.embedFiles ?? true) {
      // A file the store no longer has is left out, and import reports it.
      for (const [key, file] of attachments) {
        const stored = await files.open(key);
        if (!stored) continue;
        const hash = createHash("sha256");
        const size = await writer.addStream(
          `files/${key}`,
          stored.body,
          (chunk) => hash.update(chunk),
        );
        listed.push({
          id: key,
          name: file.name,
          size,
          sha256: hash.digest("hex"),
        });
      }
    }
    const snapshot = baseSnapshotSchema.parse({
      ...head,
      tables,
      members: await baseMembers(db, baseId),
      ...(groups ? { groups: groups.base } : {}),
      ...(listed.length > 0 ? { files: listed } : {}),
    });
    await writer.addBuffer(SNAPSHOT_ENTRY, snapshotBytes(snapshot));
    const size = await writer.finish();
    if (size > MAX_SNAPSHOT_ARCHIVE_BYTES) {
      throw new AppError("too_large_snapshot");
    }
    return {
      snapshot,
      packed: {
        kind: "zip",
        path,
        size,
        filename: snapshotFilename(described.base.name, true),
      },
      rows: written,
      files: attachments.size,
    };
  } catch (error) {
    writer.abort();
    if (error instanceof ZipError) {
      throw new AppError("too_large_snapshot", { cause: error });
    }
    throw error;
  }
}

/**
 * Attachment cells as their files, `{ file, name }`, and user cells as
 * emails: what another instance can resolve. Files of another table are
 * not this table's and are left out.
 */
async function describeCells(
  db: Database,
  tableId: string,
  rows: NonNullable<SnapshotTable["rows"]>,
  input: {
    fileColumns: ReadonlySet<string>;
    userColumns: ReadonlySet<string>;
    attachments: SnapshotAttachments;
  },
): Promise<void> {
  const strings = (value: unknown) =>
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  const keys = new Set<string>();
  const userIds = new Set<string>();
  for (const row of rows) {
    for (const name of input.fileColumns) {
      for (const key of strings(row[name])) keys.add(key);
    }
    for (const name of input.userColumns) {
      for (const id of strings(row[name])) userIds.add(id);
    }
  }
  const meta = await loadAttachmentMeta(db, [...keys]);
  const emails = new Map<string, string>();
  const ids = [...userIds];
  for (let start = 0; start < ids.length; start += 1_000) {
    const found = await db
      .selectFrom("users")
      .select(["id", "email"])
      .where("id", "in", ids.slice(start, start + 1_000))
      .execute();
    for (const user of found) emails.set(user.id, user.email);
  }
  for (const row of rows) {
    for (const name of input.fileColumns) {
      if (!(name in row)) continue;
      const files = strings(row[name]).flatMap((key) => {
        const found = meta.get(key);
        if (!found || found.tableId !== tableId) return [];
        input.attachments.set(key, { name: found.filename, size: found.size });
        return [{ file: key, name: found.filename }];
      });
      row[name] = files.length > 0 ? files : null;
    }
    for (const name of input.userColumns) {
      if (!(name in row)) continue;
      const people = strings(row[name]).flatMap((id) => {
        const email = emails.get(id);
        return email ? [email] : [];
      });
      row[name] = people.length > 0 ? people : null;
    }
  }
}

/** What an import could not bring as it was. */
type SnapshotImportReport = {
  /** Files stored again, and those the snapshot lacked or that failed. */
  files: number;
  filesMissing: number;
  /** Files of a kind or an extension this instance refuses, left out. */
  filesRefused: number;
  /** People in user cells found here, and those left out. */
  people: number;
  peopleDropped: number;
  /** Members given their role back, and those without an account here. */
  members: number;
  membersMissing: number;
  /** Members left out because they have left the base since. */
  membersLeft: number;
  /**
   * Members left out because a role they held, on the base or one of its
   * tables, was made on another instance: no role here gives exactly what
   * it gave, and nobody sees more of the new base than of the old one.
   */
  membersRoleMissing: number;
  /**
   * Widgets their dashboards came without: they read a table or a view
   * the snapshot does not hold.
   */
  widgetsLeft: number;
  /** Signed rows come back locked: a signature stays with what it signed. */
  signaturesLeft?: number;
  /**
   * A restore point's group roles left out: the group is gone, or a role
   * it held was made on another instance or changed since.
   */
  groupsLeft?: number;
};

/** Rows of access a statement writes at a time. */
const ACCESS_BATCH = 1_000;

/** The active accounts of some addresses, by their address in lower case. */
async function activeAccounts(
  db: Database,
  addresses: Iterable<string>,
): Promise<Map<string, string>> {
  const emails = [...new Set([...addresses].map((item) => item.toLowerCase()))];
  const accounts = new Map<string, string>();
  for (let start = 0; start < emails.length; start += 1_000) {
    const found = await db
      .selectFrom("users")
      .select(["id", "email"])
      .where("email", "in", emails.slice(start, start + 1_000))
      .where("disabledAt", "is", null)
      .execute();
    for (const user of found) accounts.set(user.email.toLowerCase(), user.id);
  }
  return accounts;
}

/**
 * The made roles here the snapshot's members name, and the addresses whose
 * made role finds none: those are given nothing of the new base.
 */
async function madeRolesOf(
  db: Database,
  parsed: Pick<BaseSnapshot, "members" | "tables" | "groups">,
): Promise<Pick<Restoring, "made" | "unmatched">> {
  const held = [
    ...(parsed.members ?? []).map((member) => ({
      email: member.email,
      role: member.role,
    })),
    ...parsed.tables.flatMap((table) =>
      (table.access ?? []).flatMap((item) =>
        item.role ? [{ email: item.email, role: item.role }] : [],
      ),
    ),
  ];
  const made = await madeRolesHere(db, [
    ...held.map((item) => item.role),
    // A restore point's groups name made roles too (ADR 0117).
    ...(parsed.groups ?? []).map((item) => item.role),
    ...parsed.tables.flatMap((table) =>
      (table.groups ?? []).map((item) => item.role),
    ),
  ]);
  const unmatched = new Set(
    held
      .filter((item) => givenBack(item.role, made) === null)
      .map((item) => item.email.toLowerCase()),
  );
  return { made, unmatched };
}

/** Who gets their access back on the new base: its importer has it all. */
type Restoring = {
  userId: string;
  accounts: ReadonlyMap<string, string>;
  /** Only these accounts, when given: the others are counted as left. */
  keep?: ReadonlySet<string>;
  /** The made roles here the snapshot names, by name and acts. */
  made: ReadonlyMap<string, string>;
  /** Addresses whose made role, on the base or a table, has no match here. */
  unmatched: ReadonlySet<string>;
};

/**
 * The members a rule binds on one of the snapshot's tables. A snapshot
 * made before roles added up (ADR 0131) may hold a rule beside a role on
 * the base: such a person is given back a role on each table instead, as
 * the upgrade does, so the rule still narrows what they see.
 */
function ruledMembers(tables: readonly SnapshotTable[]): Set<string> {
  return new Set(
    tables.flatMap((table) =>
      (table.access ?? []).flatMap((item) =>
        item.rowFilter || item.columns?.length
          ? [item.email.toLowerCase()]
          : [],
      ),
    ),
  );
}

/**
 * Gives the snapshot's members with an active account here their role on
 * the new base. Its importer keeps theirs. A member a rule binds gets it
 * on each table instead (`ruledMembers`): returned, by account.
 */
async function restoreMembers(
  db: Database,
  baseId: string,
  members: NonNullable<BaseSnapshot["members"]>,
  restoring: Restoring,
  report: SnapshotImportReport,
  ruled: ReadonlySet<string>,
): Promise<Map<string, GivenColumns>> {
  const held = new Map<string, GivenColumns>();
  const grants = new Map<string, GivenColumns>();
  for (const member of members) {
    const email = member.email.toLowerCase();
    const id = restoring.accounts.get(email);
    const given = givenBack(member.role, restoring.made);
    if (!id) report.membersMissing += 1;
    else if (restoring.keep && !restoring.keep.has(id)) report.membersLeft += 1;
    else if (id === restoring.userId) continue;
    else if (!given || restoring.unmatched.has(email)) {
      report.membersRoleMissing += 1;
    } else if (ruled.has(email)) held.set(id, given);
    else grants.set(id, given);
  }
  report.members += grants.size + held.size;
  if (grants.size === 0) return held;
  await withAudit(db, { userId: restoring.userId, source: "snapshot" }, (tx) =>
    tx
      .insertInto("attributions")
      .values(
        [...grants].map(([userId, given]) => ({
          userId,
          ...given,
          scope: "base" as const,
          scopeId: baseId,
        })),
      )
      .execute(),
  );
  return held;
}

/**
 * Gives a restore point's groups back their roles, as the point kept them
 * (ADR 0117): on the new base, and on each new table with its rules. A
 * group gone since, or a role no longer here, is left out and counted.
 */
async function restoreGroups(
  db: Database,
  baseId: string,
  parsed: Pick<BaseSnapshot, "groups" | "tables">,
  ids: ReadonlyMap<string, string>,
  restoring: Restoring,
  report: SnapshotImportReport,
): Promise<void> {
  type Named = NonNullable<SnapshotTable["groups"]>[number] & {
    scope: "base" | "table";
    scopeId: string;
  };
  const named: Named[] = [
    ...(parsed.groups ?? []).map((item) => ({
      ...item,
      scope: "base" as const,
      scopeId: baseId,
    })),
    ...parsed.tables.flatMap((table) => {
      const tableId = ids.get(table.key);
      return tableId
        ? (table.groups ?? []).map((item) => ({
            ...item,
            scope: "table" as const,
            scopeId: tableId,
          }))
        : [];
    }),
  ];
  if (named.length === 0) return;
  const here = new Set(
    (
      await db
        .selectFrom("groups")
        .select("id")
        .where("id", "in", [...new Set(named.map((item) => item.group))])
        .execute()
    ).map((group) => group.id),
  );
  const given = named.flatMap((item) => {
    const role = givenBack(item.role, restoring.made);
    if (!role || !here.has(item.group)) return [];
    return [
      {
        groupId: item.group,
        ...role,
        scope: item.scope,
        scopeId: item.scopeId,
        givenBy: restoring.userId,
        rowFilter: item.rowFilter ?? null,
        fieldAccess: storedFieldAccess(item.columns),
      },
    ];
  });
  const left = named.length - given.length;
  if (left > 0) report.groupsLeft = (report.groupsLeft ?? 0) + left;
  if (given.length === 0) return;
  await withAudit(db, { userId: restoring.userId, source: "snapshot" }, (tx) =>
    tx.insertInto("attributions").values(given).execute(),
  );
}

/**
 * Gives each person their own role and rules on the new tables, as the
 * snapshot keeps them: nobody sees more of the new base than they saw of
 * the base it was made of. A member held from the base (`restoreMembers`)
 * gets its role on each table, with the rules there.
 */
async function restoreTableAccess(
  db: Database,
  tables: readonly SnapshotTable[],
  ids: ReadonlyMap<string, string>,
  restoring: Restoring,
  held: ReadonlyMap<string, GivenColumns>,
): Promise<void> {
  for (const table of tables) {
    const tableId = ids.get(table.key);
    if (!tableId || (!table.access?.length && held.size === 0)) continue;
    const granted = new Map<string, TableAccess[number]>();
    for (const item of table.access ?? []) {
      const email = item.email.toLowerCase();
      const id = restoring.accounts.get(email);
      if (!id || id === restoring.userId) continue;
      if (restoring.keep && !restoring.keep.has(id)) continue;
      if (restoring.unmatched.has(email)) continue;
      granted.set(id, item);
    }
    const roles = [...new Set([...granted.keys(), ...held.keys()])].flatMap(
      (userId) => {
        const item = granted.get(userId);
        const given = item?.role
          ? givenBack(item.role, restoring.made)
          : (held.get(userId) ?? null);
        if (!given) return [];
        return [
          {
            userId,
            ...given,
            scope: "table" as const,
            scopeId: tableId,
            rowFilter: item?.rowFilter ?? null,
            fieldAccess: storedFieldAccess(item?.columns),
          },
        ];
      },
    );
    if (roles.length === 0) continue;
    await withAudit(
      db,
      { userId: restoring.userId, tableId, source: "snapshot" },
      async (tx) => {
        for (let start = 0; start < roles.length; start += ACCESS_BATCH) {
          await tx
            .insertInto("attributions")
            .values(roles.slice(start, start + ACCESS_BATCH))
            .execute();
        }
      },
    );
  }
}

/** Where a snapshot's rows go: a new table's fields, and its files so far. */
type RowTarget = {
  writable: ReadonlySet<string>;
  fileColumns: ReadonlySet<string>;
  userColumns: ReadonlySet<string>;
  /** Files stored again for this table, by their id in the snapshot. */
  stored: ReadonlyMap<string, string | null>;
};

/**
 * A snapshot row's cells as the new table takes them: its files by their
 * new keys, its people by their accounts here, its other cells as they
 * are. What the table has no field for is left out.
 */
function cellsFor(
  row: Readonly<Record<string, unknown>>,
  target: RowTarget,
  people: ReadonlyMap<string, string>,
  report: SnapshotImportReport,
): Record<string, CellValue> {
  return Object.fromEntries(
    Object.entries(row).flatMap(([key, value]): Array<[string, CellValue]> => {
      if (!target.writable.has(key)) return [];
      if (target.fileColumns.has(key)) {
        const keys = fileRefs(value).flatMap((ref) => {
          const found = target.stored.get(ref.file);
          return found ? [found] : [];
        });
        return [[key, keys.length > 0 ? keys : null]];
      }
      if (target.userColumns.has(key)) {
        const listed = Array.isArray(value)
          ? value.filter((item): item is string => typeof item === "string")
          : [];
        const found = listed.flatMap((email) => {
          const id = people.get(email.toLowerCase());
          return id ? [id] : [];
        });
        report.people += found.length;
        report.peopleDropped += listed.length - found.length;
        return [[key, found.length > 0 ? found : null]];
      }
      return Array.isArray(value) &&
        value.some((item) => typeof item !== "string")
        ? []
        : [[key, value as CellValue]];
    }),
  );
}

/**
 * Makes one link of a version 3 snapshot: its table's lines read again, a
 * batch at a time, each row pointed at the rows its line names, all of them
 * found by the sequence number they kept. One statement a batch, under the
 * trail; nothing is held but the batch.
 */
async function linkLines(
  db: Database,
  userId: string,
  input: {
    lines: AsyncIterable<SnapshotLine>;
    /** The link's field as the lines name it. */
    field: string;
    /** The link's field in the new base. */
    name: string;
    from: string;
    to: string;
    multiple: boolean;
    /** A link made leaves its row's last change as it was. */
    keepRowState: boolean;
    /** The numbers of the rows that took a new one, on either end. */
    fromSeqs: ReadonlyMap<string, string>;
    toSeqs: ReadonlyMap<string, string>;
    onRows: (count: number) => Promise<void>;
  },
): Promise<void> {
  const tables = await db
    .selectFrom("dataTables")
    .select(["id", "physicalName"])
    .where("id", "in", [input.from, input.to])
    .execute();
  const fromPhysical = tables.find((table) => table.id === input.from);
  const toPhysical = tables.find((table) => table.id === input.to);
  const { engine } = await loadEngine(db, input.from, () => true);
  const relation = engine.table.columns.find(
    (column) => column.name === input.name,
  )?.relation;
  if (!fromPhysical || !toPhysical || !relation) {
    throw new AppError("invalid_relation");
  }
  let fromSeqs: string[] = [];
  let toSeqs: string[] = [];
  let seen = 0;
  const flush = async () => {
    if (fromSeqs.length > 0) {
      let statement;
      if (relation.kind === "one_to_many" && relation.fkColumn) {
        statement = buildSnapshotForeignKeys({
          from: fromPhysical.physicalName,
          to: toPhysical.physicalName,
          column: relation.fkColumn,
          fromSeqs,
          toSeqs,
        });
      } else if (relation.kind === "many_to_many" && relation.junction) {
        statement = buildSnapshotJunction({
          from: fromPhysical.physicalName,
          to: toPhysical.physicalName,
          junction: relation.junction,
          field: input.name,
          userId,
          tableId: input.from,
          fromSeqs,
          toSeqs,
        });
      } else {
        throw new AppError("invalid_relation");
      }
      await withAudit(
        db,
        {
          userId,
          tableId: input.from,
          source: "snapshot",
          keepRowState: input.keepRowState,
        },
        (tx) => runRows(tx, statement),
      );
    }
    await input.onRows(seen);
    fromSeqs = [];
    toSeqs = [];
    seen = 0;
  };
  for await (const line of input.lines) {
    seen += 1;
    const named = snapshotLineField(line, input.field);
    if (Array.isArray(named)) {
      const targets = named.filter(
        (item): item is string => typeof item === "string" && SEQ.test(item),
      );
      for (const seq of targets.slice(0, input.multiple ? ROW_TARGETS : 1)) {
        fromSeqs.push(input.fromSeqs.get(line.__seq) ?? line.__seq);
        toSeqs.push(input.toSeqs.get(seq) ?? seq);
      }
    }
    if (
      fromSeqs.length > MAX_SNAPSHOT_LINK_PAIRS - ROW_TARGETS ||
      seen >= SNAPSHOT_PAGE
    ) {
      await flush();
    }
  }
  await flush();
}

/** What a version 4 line says its row was; a line without it is broken. */
function rowStateOf(line: SnapshotLine): SnapshotRowState {
  const parsed = snapshotRowStateSchema.safeParse(line[ROW_STATE_KEY]);
  if (!parsed.success) throw new AppError("invalid_snapshot");
  return parsed.data;
}

function stampOf(line: SnapshotLine): KeptRowStamp {
  const { createdAt, updatedAt, createdBy, updatedBy } = rowStateOf(line);
  return { createdAt, updatedAt, createdBy, updatedBy };
}

/**
 * Gives one table's rows their status back, its lines read again a batch
 * at a time: each row takes the steps that lead there, through the
 * transitions the trail records. A signed row stops at locked: its
 * signature stays with what was signed. Answers how many did.
 */
async function restoreStatuses(
  db: Database,
  userId: string,
  input: {
    tableId: string;
    physicalName: string;
    lines: AsyncIterable<SnapshotLine>;
    /** The numbers of the rows that took a new one. */
    seqs: ReadonlyMap<string, string>;
    onRows: (count: number) => Promise<void>;
  },
): Promise<number> {
  let signed = 0;
  let seen = 0;
  let submit: string[] = [];
  let lock: string[] = [];
  const move = async (
    seqs: readonly string[],
    from: "draft" | "submitted",
    to: "submitted" | "locked",
    action: "submit" | "lock",
  ) => {
    if (seqs.length === 0) return;
    await withAudit(
      db,
      { userId, tableId: input.tableId, action, source: "snapshot" },
      async (tx) => {
        const [moved] = await runRows(
          tx,
          buildSnapshotStatus({ table: input.physicalName, seqs, from, to }),
        );
        if (Number(moved?.count) !== seqs.length) {
          throw new AppError("invalid_snapshot");
        }
      },
    );
  };
  const flush = async () => {
    await move(submit, "draft", "submitted", "submit");
    await move(lock, "submitted", "locked", "lock");
    await input.onRows(seen);
    submit = [];
    lock = [];
    seen = 0;
  };
  for await (const line of input.lines) {
    seen += 1;
    const { status } = rowStateOf(line);
    const seq = input.seqs.get(line.__seq) ?? line.__seq;
    if (status === "signed") signed += 1;
    if (status !== "draft") submit.push(seq);
    if (status === "locked" || status === "signed") lock.push(seq);
    if (seen >= SNAPSHOT_PAGE) await flush();
  }
  await flush();
  return signed;
}

/**
 * Creates a new base from a snapshot. On failure the half-built base is
 * removed. Attachment cells get their files back from the archive, user
 * cells their people by email when they are members of the new base. A
 * version 3 snapshot's rows are read from their entries a batch at a time
 * and keep their sequence number and place, through which their links are
 * made (ADR 0076): only the batch is held in memory, and `maxRows` bounds
 * the whole. Versions 1 and 2 carry their rows inside the JSON. Version 4
 * brings each row's dates, authors, and status back, and is read only for a
 * caller that says the copy is the instance's own (`keepRowState`).
 */
/** Comments written in one statement while a copy is read back. */
const COMMENT_BATCH = 500;

/**
 * Gives one table of an instance's own copy its comments back (ADR 0122),
 * each on the row that took its number here, a reply on what it answers.
 * An author or a resolver whose account was erased since the copy is the
 * erased account's placeholder, as the erasure would have made them.
 */
async function restoreComments(
  db: Database,
  input: {
    tableId: string;
    physicalName: string;
    lines: AsyncIterable<SnapshotComment>;
    count: number;
    /** The numbers of the rows that took a new one. */
    renumbered: ReadonlyMap<string, string>;
  },
): Promise<void> {
  const given = new Map<string, string>();
  let batch: SnapshotComment[] = [];
  let count = 0;
  const flush = async () => {
    if (batch.length === 0) return;
    const seqs = [
      ...new Set(
        batch.map(
          (comment) => input.renumbered.get(comment.row) ?? comment.row,
        ),
      ),
    ];
    const rows = new Map<string, string>();
    for (const found of await runStatement(
      db,
      buildRowIdsBySeq({ table: input.physicalName, seqs }),
    )) {
      rows.set(String(found.seq), String(found.id));
    }
    const named = [
      ...new Set(
        batch.flatMap((comment) =>
          comment.resolvedBy
            ? [comment.author, comment.resolvedBy]
            : [comment.author],
        ),
      ),
    ];
    const accounts = new Set(
      (
        await db
          .selectFrom("users")
          .select("id")
          .where("id", "in", named)
          .execute()
      ).map((user) => user.id),
    );
    const values = batch.flatMap((comment) => {
      const rowId = rows.get(input.renumbered.get(comment.row) ?? comment.row);
      // A row added while the copy was written, after its rows were read:
      // its comment stays behind with it.
      if (!rowId) return [];
      const id = randomUUID();
      given.set(comment.id, id);
      return [
        {
          id,
          tableId: input.tableId,
          rowId,
          authorId: accounts.has(comment.author)
            ? comment.author
            : ERASED_USER_ID,
          body: comment.body,
          parentId: comment.parent ? (given.get(comment.parent) ?? null) : null,
          createdAt: comment.createdAt,
          updatedAt: comment.updatedAt,
          deletedAt: comment.deletedAt,
          resolvedAt: comment.resolvedAt,
          resolvedBy:
            comment.resolvedBy && accounts.has(comment.resolvedBy)
              ? comment.resolvedBy
              : null,
        },
      ];
    });
    if (values.length > 0) {
      await db.insertInto("comments").values(values).execute();
    }
    batch = [];
  };
  for await (const comment of input.lines) {
    count += 1;
    if (count > input.count) throw new AppError("invalid_snapshot");
    batch.push(comment);
    if (batch.length >= COMMENT_BATCH) await flush();
  }
  await flush();
  if (count !== input.count) throw new AppError("invalid_snapshot");
}

export async function importBaseSnapshot(
  db: Database,
  files: FileStore,
  userId: string,
  snapshot: BaseSnapshot,
  input: {
    name?: string;
    onCreated?: (baseId: string) => void;
    onProgress?: (done: number, total: number | null) => Promise<void>;
    /**
     * Gives members with an account here their role back, and their own
     * role and rules on each table.
     */
    restoreMembers?: boolean;
    /** Only these accounts get theirs back; the others are counted as left. */
    keepAccounts?: ReadonlySet<string>;
    /** Runs once the base and its tables exist, before their first row. */
    beforeRows?: (baseId: string) => Promise<void>;
    /** An archive's file by its id, checked; none for a JSON snapshot. */
    readFile?: (id: string, maxBytes: number) => Promise<Buffer | undefined>;
    /** Version 3: a table's lines, read from its entry in their order. */
    readLines?: (key: string) => AsyncIterable<SnapshotLine>;
    /** Version 4: a table's comments, read from their entry in their order. */
    readComments?: (key: string) => AsyncIterable<SnapshotComment>;
    /** The most rows a version 3 snapshot brings, all tables together. */
    maxRows: number;
    /** The instance's limit for one attachment. */
    maxFileBytes?: number;
    /** Names made up where the snapshot gives none; English otherwise. */
    names?: MadeNames;
    /** The copy is this instance's own: its rows' state is believed. */
    keepRowState?: boolean;
  },
): Promise<{ baseId: string; report: SnapshotImportReport }> {
  const parsed = baseSnapshotSchema.parse(snapshot);
  const lines = parsed.version >= SNAPSHOT_VERSION;
  const keepState = parsed.version === SNAPSHOT_KEPT_VERSION;
  if (keepState && !input.keepRowState) {
    throw new AppError("invalid_snapshot");
  }
  const totalRows = snapshotRowCount(parsed);
  if (lines) {
    if (totalRows > input.maxRows) {
      throw new AppError("snapshot_too_many_rows");
    }
  } else if (totalRows > MAX_SNAPSHOT_ROWS || totalRows > MAX_COPY_ROWS) {
    throw new AppError("too_many_rows");
  }
  const readLines = input.readLines;
  if (lines && totalRows > 0 && !readLines) {
    throw new AppError("invalid_snapshot");
  }
  const names = input.names ?? madeNames();
  const rowCountOf = (key: string) =>
    parsed.tables.find((table) => table.key === key)?.rowCount ?? 0;

  const created = await insertBase(db, userId, {
    name: input.name ?? parsed.base.name,
    description: parsed.base.description,
  });
  input.onCreated?.(created.id);

  const linkedRows = lines
    ? parsed.links.reduce(
        (sum, link) => sum + (link.name ? rowCountOf(link.from) : 0),
        0,
      )
    : 0;
  const total =
    parsed.tables.length +
    parsed.links.length +
    parsed.computed.length +
    1 +
    (lines ? totalRows + linkedRows : 0) +
    (keepState ? totalRows : 0);
  let done = 0;
  const step = async (count = 1) => {
    done += count;
    await input.onProgress?.(Math.min(done, total), total);
  };
  await input.onProgress?.(0, total);

  const report: SnapshotImportReport = {
    files: 0,
    filesMissing: 0,
    filesRefused: 0,
    people: 0,
    peopleDropped: 0,
    members: 0,
    membersMissing: 0,
    membersLeft: 0,
    membersRoleMissing: 0,
    widgetsLeft: 0,
  };
  try {
    const ids = new Map<string, string>();
    const rowMaps = new Map<string, Map<string, string>>();
    /**
     * By table, the rows of an instance's own copy whose number nothing
     * could follow, and the number each takes here.
     */
    const renumbered = new Map<string, Map<string, string>>();
    const seqsOfTable = (key: string) =>
      renumbered.get(key) ?? new Map<string, string>();
    const restoring: Restoring | undefined = input.restoreMembers
      ? {
          userId,
          accounts: await activeAccounts(db, [
            ...(parsed.members ?? []).map((member) => member.email),
            ...parsed.tables.flatMap((table) =>
              (table.access ?? []).map((item) => item.email),
            ),
          ]),
          ...(input.keepAccounts ? { keep: input.keepAccounts } : {}),
          ...(await madeRolesOf(db, parsed)),
        }
      : undefined;
    const held =
      restoring && parsed.members?.length
        ? await restoreMembers(
            db,
            created.id,
            parsed.members,
            restoring,
            report,
            ruledMembers(parsed.tables),
          )
        : new Map<string, GivenColumns>();
    // Formulas may read lookups and rollups, which need the links first:
    // tables start with their stored fields, formulas come at the end.
    const formulas = new Map<string, ColumnDefinition[]>();
    for (const table of parsed.tables) {
      const stored = table.columns.filter(
        (column) => column.fieldType !== "formula",
      );
      formulas.set(
        table.key,
        table.columns.filter((column) => column.fieldType === "formula"),
      );
      const made = await insertTable(db, userId, {
        baseId: created.id,
        name: table.name,
        description: table.description,
        columns:
          stored.length > 0
            ? stored
            : [
                {
                  name: names.name.toLowerCase(),
                  label: names.name,
                  fieldType: "text",
                },
              ],
        viewName: names.grid,
      });
      ids.set(table.key, made.id);
      await step();
    }
    // The folders in the snapshot's order, then each table into its own:
    // made in the order the base listed them, they keep it there.
    const folderIds = new Map<string, string>();
    for (const folder of parsed.folders ?? []) {
      const made = await createFolder(db, userId, {
        baseId: created.id,
        name: folder.name,
      });
      folderIds.set(folder.name, made.id);
    }
    for (const table of parsed.tables) {
      const tableId = ids.get(table.key);
      const folderId = table.folder ? folderIds.get(table.folder) : undefined;
      if (tableId && folderId) {
        await moveTableToFolder(db, userId, { tableId, folderId });
      }
    }
    if (restoring) {
      await restoreTableAccess(db, parsed.tables, ids, restoring, held);
      await restoreGroups(db, created.id, parsed, ids, restoring, report);
    }
    await input.beforeRows?.(created.id);

    // People in user cells: members of the new base, found by email. A
    // version 1 file names them by ids of another instance: none.
    const people = new Map<string, string>();
    if (parsed.version >= 2) {
      const members = [...(await baseCollaboratorIds(db, created.id))];
      if (members.length > 0) {
        const found = await db
          .selectFrom("users")
          .select(["id", "email"])
          .where("id", "in", members)
          .execute();
        for (const user of found) people.set(user.email, user.id);
      }
    }

    for (const table of parsed.tables) {
      const tableId = ids.get(table.key);
      if (!tableId) continue;
      if (lines ? !table.rowCount : !table.rows?.length) continue;
      const { engine, rows } = await loadEngine(db, tableId, () => true);
      const physical = rows.tables.find((item) => item.id === tableId);
      if (!physical) continue;
      const columns = writeColumns(engine).filter(
        (column) => parsed.version >= 2 || column.fieldType !== "user",
      );
      const typed = (type: FieldType) =>
        new Set(
          columns
            .filter((column) => column.fieldType === type)
            .map((column) => column.name),
        );
      const stored = new Map<string, string | null>();
      const target: RowTarget = {
        writable: new Set(columns.map((column) => column.name)),
        fileColumns: typed("attachment"),
        userColumns: typed("user"),
        stored,
      };
      const restore = (
        batch: ReadonlyArray<Readonly<Record<string, unknown>>>,
      ) =>
        restoreFiles(db, files, userId, {
          tableId,
          rows: batch,
          fileColumns: target.fileColumns,
          readFile: input.readFile,
          maxBytes: input.maxFileBytes ?? DEFAULT_ATTACHMENT_MAX_BYTES,
          report,
          stored,
        });
      const context = writeContext(userId, physical);

      if (lines && readLines) {
        let batch: SnapshotLine[] = [];
        let count = 0;
        let last = 0n;
        const flush = async () => {
          if (batch.length === 0) return;
          const fields = batch.map((line) => snapshotLineCells(line));
          await restore(fields);
          const values = fields.map((line) =>
            cellsFor(line, target, people, report),
          );
          try {
            await insertNativeBatch(db, engine, context, values, {
              seqs: batch.map((line) => line.__seq),
              positions: batch.map((line) => line.__position),
              ...(keepState ? { stamps: batch.map(stampOf) } : {}),
            });
          } catch (error) {
            // Two lines with one number, or a value twice in a field that
            // takes each once: the file does not hold together.
            if (postgresCode(error) === "23505") {
              throw new AppError("invalid_snapshot", { cause: error });
            }
            throw error;
          }
          await step(batch.length);
          batch = [];
        };
        // An instance's own copy lists its rows by number: those nothing
        // could follow come last, and go on from the others.
        const far = BigInt(FAR_ROW_NUMBER);
        const moved = new Map<string, string>();
        renumbered.set(table.key, moved);
        for await (const read of readLines(table.key)) {
          count += 1;
          if (count > (table.rowCount ?? 0)) {
            throw new AppError("invalid_snapshot");
          }
          let line = read;
          if (input.keepRowState && BigInt(read.__seq) > far) {
            const next = String(last + 1n);
            moved.set(read.__seq, next);
            line = { ...read, __seq: next };
          }
          const seq = BigInt(line.__seq);
          if (seq > last) last = seq;
          batch.push(line);
          if (batch.length >= IMPORT_BATCH) await flush();
        }
        await flush();
        if (count !== table.rowCount) throw new AppError("invalid_snapshot");
        // A row added later takes a number and a place after these.
        await withAudit(
          db,
          { userId, tableId, source: "snapshot" },
          async (tx) => {
            await runRows(
              tx,
              buildSequenceAfter({
                table: physical.physicalName,
                last: String(last),
              }),
            );
            if (input.keepRowState) {
              await runRows(
                tx,
                buildPlacesInRange({ table: physical.physicalName }),
              );
            }
            await runRows(
              tx,
              buildPositionsAfter({ table: physical.physicalName }),
            );
          },
        );
        if (table.comments) {
          if (!keepState || !input.readComments) {
            throw new AppError("invalid_snapshot");
          }
          await restoreComments(db, {
            tableId,
            physicalName: physical.physicalName,
            lines: input.readComments(table.key),
            count: table.comments,
            renumbered: moved,
          });
        }
      } else if (table.rows) {
        await restore(table.rows);
        // Versions 1 and 2 name a row's id under `__id`.
        const values = table.rows.map(({ __id: _id, ...row }) =>
          cellsFor(row, target, people, report),
        );
        const newIds = await insertNativeBatch(db, engine, context, values);
        const map = new Map<string, string>();
        table.rows.forEach((row, index) => {
          const oldId = typeof row.__id === "string" ? row.__id : undefined;
          const newId = newIds[index];
          if (oldId && newId) map.set(oldId, newId);
        });
        rowMaps.set(table.key, map);
      }
    }

    for (const link of parsed.links) {
      const from = ids.get(link.from);
      const to = ids.get(link.to);
      if (!from || !to) continue;
      const relation = await addRelation(db, userId, {
        tableId: from,
        name: link.name,
        label: link.label,
        kind: link.multiple ? "many_to_many" : "one_to_many",
        targetTableId: to,
        twoWay: link.twoWay,
        inverseLabel: link.inverseLabel,
        inverseName: link.inverseName,
      });
      if (lines) {
        if (readLines && link.name && rowCountOf(link.from) > 0) {
          await linkLines(db, userId, {
            lines: readLines(link.from),
            field: link.name,
            name: relation.name,
            from,
            to,
            multiple: link.multiple,
            keepRowState: keepState,
            fromSeqs: seqsOfTable(link.from),
            toSeqs: seqsOfTable(link.to),
            onRows: (count) => step(count),
          });
        }
      } else if (link.links?.length) {
        const fromMap = rowMaps.get(link.from) ?? new Map<string, string>();
        const toMap = rowMaps.get(link.to) ?? new Map<string, string>();
        const { engine, rows } = await loadEngine(db, from, () => true);
        const physical = rows.tables.find((item) => item.id === from);
        const column = engine.table.columns.find(
          (item) => item.name === relation.name,
        );
        if (physical && column) {
          for (const edge of link.links) {
            const rowId = fromMap.get(edge.from);
            if (!rowId) continue;
            const targetIds = edge.to.flatMap((id) => {
              const mapped = toMap.get(id);
              return mapped ? [mapped] : [];
            });
            if (targetIds.length === 0) continue;
            await setLinks(db, engine, {
              userId,
              tableId: from,
              physicalName: physical.physicalName,
              column,
              rowId,
              targetIds: link.multiple ? targetIds : targetIds.slice(0, 1),
              reason: null,
              source: "snapshot",
            });
          }
        }
      }
      await step();
    }

    for (const item of parsed.computed) {
      const tableId = ids.get(item.table);
      if (!tableId) continue;
      await insertComputed(
        db,
        userId,
        {
          tableId,
          name: item.name,
          label: item.label,
          relation: item.relation,
          target: item.target,
          fn: item.fn,
        },
        () => true,
      );
      await step();
    }

    // A formula may read another formula: add them until none is left, or
    // none can be added, which means the snapshot does not hold together.
    for (const table of parsed.tables) {
      const tableId = ids.get(table.key);
      let pending = [...(formulas.get(table.key) ?? [])];
      if (!tableId) continue;
      while (pending.length > 0) {
        const failed: ColumnDefinition[] = [];
        let lastError: unknown;
        for (const definition of pending) {
          try {
            await addColumn(db, userId, tableId, definition);
          } catch (error) {
            failed.push(definition);
            lastError = error;
          }
        }
        if (failed.length === pending.length) throw lastError;
        pending = failed;
      }
      if (table.primary) {
        await setPrimaryColumn(db, userId, tableId, table.primary);
      }
    }

    /** Each table's views as made here, in the snapshot's order. */
    const viewIds = new Map<string, string[]>();
    for (const table of parsed.tables) {
      const tableId = ids.get(table.key);
      if (!tableId) continue;
      const { engine } = await loadEngine(db, tableId, () => true);
      // The snapshot's collaborative views replace the grid made with the
      // table; a table that lists none keeps it.
      if (table.views.length > 0) {
        await withAudit(db, { userId, tableId, source: "snapshot" }, (tx) =>
          tx.deleteFrom("views").where("tableId", "=", tableId).execute(),
        );
      }
      const made: string[] = [];
      for (const view of table.views) {
        const created = await createView(db, engine, userId, {
          tableId,
          name: view.name,
          viewType: view.viewType,
          config: view.config,
          ownerId: null,
        });
        made.push(created.id);
      }
      viewIds.set(table.key, made);
    }

    // Its dashboards last: a widget reads a table and a view made above.
    for (const dashboard of parsed.dashboards ?? []) {
      const board = await createDashboard(
        db,
        userId,
        {
          baseId: created.id,
          name: dashboard.name,
          description: dashboard.description,
        },
        "snapshot",
      );
      for (const widget of dashboard.widgets) {
        const tableId = ids.get(widget.table);
        const viewId =
          widget.view === undefined
            ? undefined
            : viewIds.get(widget.table)?.[widget.view];
        if (!tableId || (widget.view !== undefined && !viewId)) {
          throw new AppError("invalid_snapshot");
        }
        await upsertWidget(
          db,
          userId,
          created.id,
          {
            dashboardId: board.id,
            title: widget.title,
            kind: widget.kind,
            x: widget.x,
            y: widget.y,
            w: widget.w,
            h: widget.h,
            config: widgetConfigOn(widget.config, tableId, viewId),
          },
          "snapshot",
        );
      }
      report.widgetsLeft += dashboard.left ?? 0;
    }

    // Each row's status last: a locked row takes no link or other write.
    if (keepState && readLines) {
      let signed = 0;
      for (const table of parsed.tables) {
        const tableId = ids.get(table.key);
        if (!tableId || !table.rowCount) continue;
        const { physicalName } = await db
          .selectFrom("dataTables")
          .select("physicalName")
          .where("id", "=", tableId)
          .executeTakeFirstOrThrow();
        signed += await restoreStatuses(db, userId, {
          tableId,
          physicalName,
          lines: readLines(table.key),
          seqs: seqsOfTable(table.key),
          onRows: (count) => step(count),
        });
      }
      if (signed > 0) report.signaturesLeft = signed;
    }

    await input.onProgress?.(total, total);
    return { baseId: created.id, report };
  } catch (error) {
    await removeBase(db, files, userId, created.id, () => {}).catch(
      () => undefined,
    );
    throw error;
  }
}

/** An attachment cell's files, as a snapshot names them. */
function fileRefs(value: unknown): SnapshotFileRef[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const parsed = snapshotFileRefSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

/**
 * Stores again, for one new table, the files its attachment cells name:
 * each once, checked by the archive, thumbnails made as on upload. Their
 * new keys go into `stored` by snapshot id, beside those of the table's
 * earlier rows; a file the snapshot lacks is kept there as null, counted
 * once.
 */
async function restoreFiles(
  db: Database,
  files: FileStore,
  userId: string,
  input: {
    tableId: string;
    rows: ReadonlyArray<Readonly<Record<string, unknown>>>;
    fileColumns: ReadonlySet<string>;
    readFile:
      | ((id: string, maxBytes: number) => Promise<Buffer | undefined>)
      | undefined;
    maxBytes: number;
    report: SnapshotImportReport;
    stored: Map<string, string | null>;
  },
): Promise<void> {
  const wanted = new Map<string, string>();
  for (const row of input.rows) {
    for (const name of input.fileColumns) {
      for (const ref of fileRefs(row[name])) {
        if (!input.stored.has(ref.file) && !wanted.has(ref.file)) {
          wanted.set(ref.file, ref.name);
        }
      }
    }
  }
  for (const [id, name] of wanted) {
    let bytes: Buffer | undefined;
    try {
      bytes = await input.readFile?.(id, input.maxBytes);
    } catch {
      bytes = undefined;
    }
    if (!bytes) {
      input.stored.set(id, null);
      input.report.filesMissing += 1;
      continue;
    }
    let meta: Awaited<ReturnType<typeof storeAttachment>>;
    try {
      meta = await storeAttachment(db, files, {
        tableId: input.tableId,
        userId,
        filename: cleanFilename(name),
        bytes,
      });
    } catch (error) {
      // A rule set here after the snapshot was made: the base still comes
      // back, without that file, and the report says so.
      if (
        error instanceof AppError &&
        error.code === "attachment_type_refused"
      ) {
        input.stored.set(id, null);
        input.report.filesRefused += 1;
        continue;
      }
      throw error;
    }
    input.stored.set(id, meta.key);
    input.report.files += 1;
  }
}

/**
 * A version 3 table's lines, read from its entry as the archive is, each
 * checked; a broken line or entry refuses the snapshot.
 */
export async function* readSnapshotLines(
  archive: ZipReader,
  key: string,
  /** The instance's own copy: numbers as its tables hold them, and state. */
  options: { own?: boolean } = {},
): AsyncGenerator<SnapshotLine> {
  const schema = options.own ? ownSnapshotLineSchema : snapshotLineSchema;
  try {
    for await (const text of archive.lines(snapshotRowsEntry(key), {
      maxLine: MAX_SNAPSHOT_LINE_BYTES,
    })) {
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        throw new AppError("invalid_snapshot");
      }
      const parsed = schema.safeParse(raw);
      if (!parsed.success) throw new AppError("invalid_snapshot");
      yield parsed.data;
    }
  } catch (error) {
    if (error instanceof ZipError) {
      throw new AppError("invalid_snapshot", { cause: error });
    }
    throw error;
  }
}

/** A table's comments in an instance's own copy, each line checked. */
export async function* readSnapshotComments(
  archive: ZipReader,
  key: string,
): AsyncGenerator<SnapshotComment> {
  try {
    for await (const text of archive.lines(snapshotCommentsEntry(key), {
      maxLine: MAX_SNAPSHOT_LINE_BYTES,
    })) {
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        throw new AppError("invalid_snapshot");
      }
      const parsed = snapshotCommentSchema.safeParse(raw);
      if (!parsed.success) throw new AppError("invalid_snapshot");
      yield parsed.data;
    }
  } catch (error) {
    if (error instanceof ZipError) {
      throw new AppError("invalid_snapshot", { cause: error });
    }
    throw error;
  }
}

export function parseSnapshotBytes(bytes: Buffer): BaseSnapshot {
  if (bytes.length > MAX_SNAPSHOT_BYTES) {
    throw new AppError("too_large_snapshot");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new AppError("invalid_snapshot");
  }
  return baseSnapshotSchema.parse(raw);
}
