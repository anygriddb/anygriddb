import {
  AppError,
  buildPositionsAfter,
  buildRowSeqs,
  buildSequenceAfter,
  buildSnapshotForeignKeys,
  buildSnapshotJunction,
  buildSnapshotKeys,
  DEFAULT_ATTACHMENT_MAX_BYTES,
  type BaseSnapshot,
  baseSnapshotSchema,
  type CellValue,
  type ColumnDefinition,
  CREATABLE_TYPES,
  deriveColumnName,
  type EngineCatalog,
  type FieldType,
  filterGroupSchema,
  type FormulaExpr,
  type MadeNames,
  madeNames,
  MAX_SNAPSHOT_ARCHIVE_BYTES,
  MAX_SNAPSHOT_BYTES,
  MAX_SNAPSHOT_FILES,
  MAX_SNAPSHOT_LINE_BYTES,
  MAX_SNAPSHOT_LINK_PAIRS,
  MAX_SNAPSHOT_ROWS,
  normalizeViewConfig,
  ROLLUP_FNS,
  type RollupFn,
  type Role,
  roleFor,
  SNAPSHOT_ENTRY,
  SNAPSHOT_KIND,
  SNAPSHOT_VERSION,
  type SnapshotFile,
  type SnapshotFileRef,
  snapshotFileRefSchema,
  snapshotFilename,
  type SnapshotLine,
  snapshotLineSchema,
  type SnapshotLink,
  snapshotRowCount,
  snapshotRowsEntry,
  type SnapshotTable,
} from "@anygriddb/core";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { runStatement, type Database } from "@anygriddb/db";
import {
  cleanFilename,
  loadAttachmentMeta,
  storeAttachment,
} from "../attachments.js";
import { runRows, withAudit } from "./audit-context.js";
import { insertComputed } from "./computed.js";
import { MAX_COPY_ROWS, toCell } from "./data-ops.js";
import { loadEngine, sortColumns, type ColumnRow } from "./engine.js";
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
  const rows = await db
    .selectFrom("roleBindings as b")
    .innerJoin("users as u", "u.id", "b.userId")
    .select(["u.email", "b.role"])
    .where("b.scope", "=", "base")
    .where("b.scopeId", "=", baseId)
    .where("b.groupId", "is", null)
    .execute();
  const best = new Map<string, Role>();
  for (const row of rows) {
    const current = best.get(row.email);
    best.set(
      row.email,
      current
        ? (roleFor(
            [
              { role: current, scope: "base", scopeId: baseId },
              { role: row.role, scope: "base", scopeId: baseId },
            ],
            "base",
            baseId,
          ) ?? current)
        : row.role,
    );
  }
  return [...best].map(([email, role]) => ({ email, role }));
}

type TableAccess = NonNullable<SnapshotTable["access"]>;

/**
 * Each person's own access to the base's tables, by email: a role that
 * replaces the base's on a table, and their row and field rules. A rule
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
    .selectFrom("roleBindings as b")
    .innerJoin("users as u", "u.id", "b.userId")
    .select(["b.scopeId as tableId", "u.email", "b.role"])
    .where("b.scope", "=", "table")
    .where("b.scopeId", "in", tableIds)
    .where("b.groupId", "is", null)
    .execute();
  for (const row of roles) {
    const current = entry(row.tableId, row.email);
    current.role = current.role
      ? (roleFor(
          [
            { role: current.role, scope: "table", scopeId: row.tableId },
            { role: row.role, scope: "table", scopeId: row.tableId },
          ],
          "table",
          row.tableId,
        ) ?? current.role)
      : row.role;
  }
  const rules = await db
    .selectFrom("tableAcls as a")
    .innerJoin("users as u", "u.id", "a.userId")
    .select(["a.tableId", "u.email", "a.rowFilter"])
    .where("a.tableId", "in", tableIds)
    .execute();
  for (const row of rules) {
    if (!row.rowFilter) continue;
    const parsed = filterGroupSchema.safeParse(row.rowFilter);
    entry(row.tableId, row.email).rowFilter = parsed.success
      ? parsed.data
      : { conjunction: "or", conditions: [] };
  }
  const columns = await db
    .selectFrom("columnAcls as c")
    .innerJoin("users as u", "u.id", "c.userId")
    .select(["c.tableId", "u.email", "c.columnName", "c.access"])
    .where("c.tableId", "in", tableIds)
    .orderBy("c.columnName")
    .execute();
  for (const row of columns) {
    const current = entry(row.tableId, row.email);
    current.columns = [
      ...(current.columns ?? []),
      { column: row.columnName, access: row.access },
    ];
  }
  return new Map(
    [...found].map(([tableId, byEmail]) => [tableId, [...byEmail.values()]]),
  );
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
  if (tableRows.length === 0) throw new AppError("no_tables");

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
        columns: stored.map(definitionOf),
        primary,
        views: viewRows
          .filter((view) => !view.ownerId)
          .map((view) => ({
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
  };
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
 * numbers of the rows its links name. A row added or removed while it
 * reads is written once or not at all, never twice.
 */
async function* tableLines(
  db: Database,
  table: SourceTable,
  attachments: SnapshotAttachments,
  onRows: (count: number) => Promise<void>,
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
      cells: Record<string, CellValue | string | undefined>;
    }> = [];
    for (const key of keys) {
      const source = byId.get(String(key.id));
      // Removed between the two reads.
      if (!source) continue;
      const cells: Record<string, CellValue | string | undefined> = {
        __seq: String(key.seq),
        __position: String(key.position),
      };
      for (const name of table.writable) cells[name] = toCell(source[name]);
      rows.push({ source, cells });
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
    for (const row of rows) yield `${JSON.stringify(row.cells)}\n`;
    await onRows(rows.length);
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
export type PackedSnapshot =
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
    onProgress?: (done: number, total: number | null) => Promise<void>;
  },
): Promise<WrittenSnapshot> {
  const described = await describeBase(db, baseId);
  const head = {
    kind: SNAPSHOT_KIND,
    version: SNAPSHOT_VERSION,
    exportedAt: new Date().toISOString(),
    base: {
      name: described.base.name,
      description: described.base.description ?? undefined,
    },
    links: described.links,
    computed: described.computed,
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
    const tables: SnapshotTable[] = [];
    for (const table of described.tables) {
      let rowCount = 0;
      await writer.addDeflatedStream(
        snapshotRowsEntry(table.key),
        tableLines(db, table, attachments, async (count) => {
          rowCount += count;
          written += count;
          // Rows added while it reads count too.
          if (written > input.maxRows) {
            throw new AppError("snapshot_too_many_rows");
          }
          await input.onProgress?.(Math.min(written, total), total);
        }),
      );
      const people = access.get(table.id);
      tables.push({
        ...table.snapshot,
        rowCount,
        ...(people?.length ? { access: people } : {}),
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
  /** People in user cells found here, and those left out. */
  people: number;
  peopleDropped: number;
  /** Members given their role back, and those without an account here. */
  members: number;
  membersMissing: number;
  /** Members left out because they have left the base since. */
  membersLeft: number;
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

/** Who gets their access back on the new base: its importer has it all. */
type Restoring = {
  userId: string;
  accounts: ReadonlyMap<string, string>;
  /** Only these accounts, when given: the others are counted as left. */
  keep?: ReadonlySet<string>;
};

/**
 * Gives the snapshot's members with an active account here their role on
 * the new base. Its importer keeps theirs.
 */
async function restoreMembers(
  db: Database,
  baseId: string,
  members: NonNullable<BaseSnapshot["members"]>,
  restoring: Restoring,
  report: SnapshotImportReport,
): Promise<void> {
  const grants = new Map<string, Role>();
  for (const member of members) {
    const id = restoring.accounts.get(member.email.toLowerCase());
    if (!id) report.membersMissing += 1;
    else if (restoring.keep && !restoring.keep.has(id)) report.membersLeft += 1;
    else if (id !== restoring.userId) grants.set(id, member.role);
  }
  if (grants.size === 0) return;
  await withAudit(db, { userId: restoring.userId, source: "snapshot" }, (tx) =>
    tx
      .insertInto("roleBindings")
      .values(
        [...grants].map(([userId, role]) => ({
          userId,
          role,
          scope: "base" as const,
          scopeId: baseId,
        })),
      )
      .execute(),
  );
  report.members += grants.size;
}

/**
 * Gives each person their own role and rules on the new tables, as the
 * snapshot keeps them: nobody sees more of the new base than they saw of
 * the base it was made of.
 */
async function restoreTableAccess(
  db: Database,
  tables: readonly SnapshotTable[],
  ids: ReadonlyMap<string, string>,
  restoring: Restoring,
): Promise<void> {
  for (const table of tables) {
    const tableId = ids.get(table.key);
    if (!tableId || !table.access?.length) continue;
    const granted = new Map<string, TableAccess[number]>();
    for (const item of table.access) {
      const id = restoring.accounts.get(item.email.toLowerCase());
      if (!id || id === restoring.userId) continue;
      if (restoring.keep && !restoring.keep.has(id)) continue;
      granted.set(id, item);
    }
    if (granted.size === 0) continue;
    const entries = [...granted];
    const roles = entries.flatMap(([userId, item]) =>
      item.role
        ? [
            {
              userId,
              role: item.role,
              scope: "table" as const,
              scopeId: tableId,
            },
          ]
        : [],
    );
    const rules = entries.flatMap(([userId, item]) =>
      item.rowFilter || item.columns?.length
        ? [
            {
              tableId,
              userId,
              rowFilter: item.rowFilter ?? null,
              updatedAt: new Date(),
            },
          ]
        : [],
    );
    const columns = entries.flatMap(([userId, item]) =>
      (item.columns ?? []).map((column) => ({
        tableId,
        userId,
        columnName: column.column,
        access: column.access,
      })),
    );
    await withAudit(
      db,
      { userId: restoring.userId, tableId, source: "snapshot" },
      async (tx) => {
        for (let start = 0; start < roles.length; start += ACCESS_BATCH) {
          await tx
            .insertInto("roleBindings")
            .values(roles.slice(start, start + ACCESS_BATCH))
            .execute();
        }
        for (let start = 0; start < rules.length; start += ACCESS_BATCH) {
          await tx
            .insertInto("tableAcls")
            .values(rules.slice(start, start + ACCESS_BATCH))
            .execute();
        }
        for (let start = 0; start < columns.length; start += ACCESS_BATCH) {
          await tx
            .insertInto("columnAcls")
            .values(columns.slice(start, start + ACCESS_BATCH))
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
 * are. What the table has no field for, and the row's number and place,
 * are left out.
 */
function cellsFor(
  row: Readonly<Record<string, unknown>>,
  target: RowTarget,
  people: ReadonlyMap<string, string>,
  report: SnapshotImportReport,
): Record<string, CellValue> {
  return Object.fromEntries(
    Object.entries(row).flatMap(([key, value]): Array<[string, CellValue]> => {
      if (key === "__id" || !target.writable.has(key)) return [];
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
        { userId, tableId: input.from, source: "snapshot" },
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
    const named = line[input.field];
    if (Array.isArray(named)) {
      const targets = named.filter(
        (item): item is string => typeof item === "string" && SEQ.test(item),
      );
      for (const seq of targets.slice(0, input.multiple ? ROW_TARGETS : 1)) {
        fromSeqs.push(line.__seq);
        toSeqs.push(seq);
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

/**
 * Creates a new base from a snapshot. On failure the half-built base is
 * removed. Attachment cells get their files back from the archive, user
 * cells their people by email when they are members of the new base. A
 * version 3 snapshot's rows are read from their entries a batch at a time
 * and keep their sequence number and place, through which their links are
 * made (ADR 0076): only the batch is held in memory, and `maxRows` bounds
 * the whole. Versions 1 and 2 carry their rows inside the JSON.
 */
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
    /** The most rows a version 3 snapshot brings, all tables together. */
    maxRows: number;
    /** The instance's limit for one attachment. */
    maxFileBytes?: number;
    /** Names made up where the snapshot gives none; English otherwise. */
    names?: MadeNames;
  },
): Promise<{ baseId: string; report: SnapshotImportReport }> {
  const parsed = baseSnapshotSchema.parse(snapshot);
  const lines = parsed.version === SNAPSHOT_VERSION;
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
    (lines ? totalRows + linkedRows : 0);
  let done = 0;
  const step = async (count = 1) => {
    done += count;
    await input.onProgress?.(Math.min(done, total), total);
  };
  await input.onProgress?.(0, total);

  const report: SnapshotImportReport = {
    files: 0,
    filesMissing: 0,
    people: 0,
    peopleDropped: 0,
    members: 0,
    membersMissing: 0,
    membersLeft: 0,
  };
  try {
    const ids = new Map<string, string>();
    const rowMaps = new Map<string, Map<string, string>>();
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
        }
      : undefined;
    if (restoring && parsed.members?.length) {
      await restoreMembers(db, created.id, parsed.members, restoring, report);
    }
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
    if (restoring) await restoreTableAccess(db, parsed.tables, ids, restoring);
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
          await restore(batch);
          const values = batch.map((line) =>
            cellsFor(line, target, people, report),
          );
          try {
            await insertNativeBatch(db, engine, context, values, {
              seqs: batch.map((line) => line.__seq),
              positions: batch.map((line) => line.__position),
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
        for await (const line of readLines(table.key)) {
          count += 1;
          if (count > (table.rowCount ?? 0)) {
            throw new AppError("invalid_snapshot");
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
            await runRows(
              tx,
              buildPositionsAfter({ table: physical.physicalName }),
            );
          },
        );
      } else if (table.rows) {
        await restore(table.rows);
        const values = table.rows.map((row) =>
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

    for (const table of parsed.tables) {
      const tableId = ids.get(table.key);
      if (!tableId) continue;
      const { engine } = await loadEngine(db, tableId, () => true);
      // The snapshot's collaborative views replace the grid made with the
      // table; a table that lists none keeps it.
      if (table.views.length > 0) {
        await db.deleteFrom("views").where("tableId", "=", tableId).execute();
      }
      for (const view of table.views) {
        await createView(db, engine, {
          tableId,
          name: view.name,
          viewType: view.viewType,
          config: view.config,
          ownerId: null,
        });
      }
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
    const meta = await storeAttachment(db, files, {
      tableId: input.tableId,
      userId,
      filename: cleanFilename(name),
      bytes,
    });
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
): AsyncGenerator<SnapshotLine> {
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
      const parsed = snapshotLineSchema.safeParse(raw);
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
