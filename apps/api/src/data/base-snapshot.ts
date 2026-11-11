import {
  AppError,
  DEFAULT_ATTACHMENT_MAX_BYTES,
  type BaseSnapshot,
  baseSnapshotSchema,
  type CellValue,
  type ColumnDefinition,
  CREATABLE_TYPES,
  deriveColumnName,
  type FieldType,
  type FormulaExpr,
  type MadeNames,
  madeNames,
  MAX_SNAPSHOT_ARCHIVE_BYTES,
  MAX_SNAPSHOT_BYTES,
  MAX_SNAPSHOT_FILES,
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
  type SnapshotLink,
  type SnapshotTable,
} from "@anygriddb/core";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Database } from "@anygriddb/db";
import {
  cleanFilename,
  loadAttachmentMeta,
  storeAttachment,
} from "../attachments.js";
import { withAudit } from "./audit-context.js";
import { insertComputed } from "./computed.js";
import { MAX_COPY_ROWS, readAll, toCell } from "./data-ops.js";
import { loadEngine, sortColumns, type ColumnRow } from "./engine.js";
import { liveBase, liveTable, liveView } from "./live.js";
import { addRelation, setLinks } from "./relations.js";
import {
  baseCollaboratorIds,
  readPage,
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
import { ZipError, ZipWriter } from "./zip.js";

const LINK_TYPES = new Set<FieldType>([
  "relation_one_to_many",
  "relation_many_to_many",
]);
const COMPUTED_TYPES = new Set<FieldType>(["lookup", "rollup"]);

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
    unique: column.isUnique,
    config,
    formula: column.fieldType === "formula" ? expr : undefined,
  };
}

/** Stable key from a table name for cross-references inside the file. */
export function tableKey(name: string, used: Set<string>): string {
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
export type SnapshotAttachments = Map<string, { name: string; size: number }>;

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

/**
 * Builds a portable snapshot of a base: its schema and views and, with
 * data, its rows, its members, people by email, and the attachments its
 * cells name, which `packSnapshot` puts in an archive.
 */
export async function exportBaseSnapshot(
  db: Database,
  baseId: string,
  input: {
    withData: boolean;
    onProgress?: (done: number, total: number | null) => Promise<void>;
  },
): Promise<{
  snapshot: BaseSnapshot;
  attachments: SnapshotAttachments;
  baseName: string;
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
  for (const table of tableRows) {
    idToKey.set(table.id, tableKey(table.name, keys));
  }

  let rowBudget = 0;
  const attachments: SnapshotAttachments = new Map();
  const snapshotTables: SnapshotTable[] = [];
  const snapshotLinks: SnapshotLink[] = [];
  const computed: BaseSnapshot["computed"] = [];
  const emittedLinks = new Set<string>();

  const totalSteps = tableRows.length * (input.withData ? 2 : 1) + 1;
  let step = 0;
  await input.onProgress?.(0, totalSteps);

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

    const snapshotTable: SnapshotTable = {
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
    };

    for (const column of own.filter((item) => LINK_TYPES.has(item.fieldType))) {
      const engineColumn = engine.table.columns.find(
        (item) => item.id === column.id,
      );
      const relation = engineColumn?.relation;
      if (!relation || relation.direction !== "forward") continue;
      const toKey = idToKey.get(relation.targetTableId);
      if (!toKey) continue;
      const mark = `${key}:${column.name}`;
      if (emittedLinks.has(mark)) continue;
      emittedLinks.add(mark);
      const stored = rows.relations.find(
        (item) => item.fromColumnId === column.id,
      );
      const inverse = stored?.inverseColumnId
        ? rows.columns.find((item) => item.id === stored.inverseColumnId)
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

    step += 1;
    await input.onProgress?.(step, totalSteps);

    if (input.withData) {
      const counted = await readPage(
        db,
        engine,
        { limit: 1, fields: [] },
        { total: true },
      );
      const total = counted.total ?? 0;
      if (rowBudget + total > MAX_SNAPSHOT_ROWS) {
        throw new AppError("too_many_rows");
      }
      rowBudget += total;
      const writable = writeColumns(engine).map((column) => column.name);
      const typed = (type: FieldType) =>
        new Set(
          writeColumns(engine)
            .filter((column) => column.fieldType === type)
            .map((column) => column.name),
        );
      const fileColumns = typed("attachment");
      const userColumns = typed("user");
      const linkNames = own
        .filter((column) => LINK_TYPES.has(column.fieldType))
        .map((column) => column.name);
      const rowsOut: NonNullable<SnapshotTable["rows"]> = [];
      const linkBuckets = new Map<string, Map<string, string[]>>();

      await readAll(db, engine, [...writable, ...linkNames], (page) => {
        for (const row of page) {
          const cells: Record<string, CellValue | string | undefined> = {
            __id: row.id,
          };
          for (const name of writable) {
            cells[name] = toCell(row[name]);
          }
          rowsOut.push(cells as NonNullable<SnapshotTable["rows"]>[number]);
          for (const name of linkNames) {
            const targets = linkIds(row[name]);
            if (targets.length === 0) continue;
            let bucket = linkBuckets.get(name);
            if (!bucket) {
              bucket = new Map();
              linkBuckets.set(name, bucket);
            }
            bucket.set(row.id, targets);
          }
        }
      });
      await describeCells(db, table.id, rowsOut, {
        fileColumns,
        userColumns,
        attachments,
      });
      snapshotTable.rows = rowsOut;

      for (const link of snapshotLinks) {
        if (link.from !== key) continue;
        const name = link.name;
        if (!name) continue;
        const bucket = linkBuckets.get(name);
        if (!bucket) continue;
        link.links = [...bucket.entries()].map(([from, to]) => ({ from, to }));
      }
    }

    snapshotTables.push(snapshotTable);
    step += 1;
    await input.onProgress?.(step, totalSteps);
  }

  const snapshot = baseSnapshotSchema.parse({
    kind: SNAPSHOT_KIND,
    version: SNAPSHOT_VERSION,
    exportedAt: new Date().toISOString(),
    base: {
      name: base.name,
      description: base.description ?? undefined,
    },
    tables: snapshotTables,
    links: snapshotLinks,
    computed,
    ...(input.withData ? { members: await baseMembers(db, baseId) } : {}),
  });
  await input.onProgress?.(totalSteps, totalSteps);
  return { snapshot, attachments, baseName: base.name };
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

/** A snapshot written out: JSON bytes, or an archive in a local file. */
export type PackedSnapshot =
  | { kind: "json"; bytes: Buffer; filename: string }
  | { kind: "zip"; path: string; size: number; filename: string };

/**
 * Writes a snapshot: JSON alone, or, when its cells name files, a ZIP
 * archive in `folder` with `snapshot.json` and each file under
 * `files/<key>`, listed with its size and SHA-256. A file the store no
 * longer has is left out, and import reports it.
 */
export async function packSnapshot(
  files: FileStore,
  exported: {
    snapshot: BaseSnapshot;
    attachments: SnapshotAttachments;
    baseName: string;
  },
  folder: string,
): Promise<PackedSnapshot> {
  const json = (snapshot: BaseSnapshot) => {
    const bytes = Buffer.from(`${JSON.stringify(snapshot)}\n`, "utf8");
    if (bytes.length > MAX_SNAPSHOT_BYTES) {
      throw new AppError("too_large_snapshot");
    }
    return bytes;
  };
  if (exported.attachments.size === 0) {
    return {
      kind: "json",
      bytes: json(exported.snapshot),
      filename: snapshotFilename(exported.baseName),
    };
  }
  if (exported.attachments.size > MAX_SNAPSHOT_FILES) {
    throw new AppError("too_large_snapshot");
  }
  const path = join(folder, "snapshot.zip");
  const writer = new ZipWriter(path);
  try {
    const listed: SnapshotFile[] = [];
    for (const [key, file] of exported.attachments) {
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
    await writer.addBuffer(
      SNAPSHOT_ENTRY,
      json({ ...exported.snapshot, files: listed }),
    );
    const size = await writer.finish();
    if (size > MAX_SNAPSHOT_ARCHIVE_BYTES) {
      throw new AppError("too_large_snapshot");
    }
    return {
      kind: "zip",
      path,
      size,
      filename: snapshotFilename(exported.baseName, true),
    };
  } catch (error) {
    writer.abort();
    if (error instanceof ZipError) {
      throw new AppError("too_large_snapshot", { cause: error });
    }
    throw error;
  }
}

/** What an import could not bring as it was. */
export type SnapshotImportReport = {
  /** Files stored again, and those the snapshot lacked or that failed. */
  files: number;
  filesMissing: number;
  /** People in user cells found here, and those left out. */
  people: number;
  peopleDropped: number;
  /** Members given their role back, and those without an account here. */
  members: number;
  membersMissing: number;
};

/**
 * Gives the snapshot's members with an active account here their role on
 * the new base. Its importer keeps theirs.
 */
async function restoreMembers(
  db: Database,
  userId: string,
  baseId: string,
  members: NonNullable<BaseSnapshot["members"]>,
  report: SnapshotImportReport,
): Promise<void> {
  const emails = [
    ...new Set(members.map((member) => member.email.toLowerCase())),
  ];
  const accounts = new Map<string, string>();
  for (let start = 0; start < emails.length; start += 1_000) {
    const found = await db
      .selectFrom("users")
      .select(["id", "email"])
      .where("email", "in", emails.slice(start, start + 1_000))
      .where("disabledAt", "is", null)
      .execute();
    for (const user of found) accounts.set(user.email, user.id);
  }
  const grants = members.flatMap((member) => {
    const id = accounts.get(member.email.toLowerCase());
    if (!id) {
      report.membersMissing += 1;
      return [];
    }
    return id === userId ? [] : [{ userId: id, role: member.role }];
  });
  if (grants.length === 0) return;
  await withAudit(db, { userId, source: "snapshot" }, (tx) =>
    tx
      .insertInto("roleBindings")
      .values(
        grants.map((grant) => ({
          ...grant,
          scope: "base" as const,
          scopeId: baseId,
        })),
      )
      .execute(),
  );
  report.members += grants.length;
}

/**
 * Creates a new base from a snapshot. On failure the half-built base is
 * removed. Attachment cells get their files back from the archive, user
 * cells their people by email when they are members of the new base.
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
    /** Gives members with an account here their role back. */
    restoreMembers?: boolean;
    /** An archive's file by its id, checked; none for a JSON snapshot. */
    readFile?: (id: string, maxBytes: number) => Promise<Buffer | undefined>;
    /** The instance's limit for one attachment. */
    maxFileBytes?: number;
    /** Names made up where the snapshot gives none; English otherwise. */
    names?: MadeNames;
  },
): Promise<{ baseId: string; report: SnapshotImportReport }> {
  const parsed = baseSnapshotSchema.parse(snapshot);
  const names = input.names ?? madeNames();
  const totalRows = parsed.tables.reduce(
    (sum, table) => sum + (table.rows?.length ?? 0),
    0,
  );
  if (totalRows > MAX_SNAPSHOT_ROWS || totalRows > MAX_COPY_ROWS) {
    throw new AppError("too_many_rows");
  }

  const created = await insertBase(db, userId, {
    name: input.name ?? parsed.base.name,
    description: parsed.base.description,
  });
  input.onCreated?.(created.id);

  const total =
    parsed.tables.length + parsed.links.length + parsed.computed.length + 1;
  let done = 0;
  await input.onProgress?.(0, total);

  const report: SnapshotImportReport = {
    files: 0,
    filesMissing: 0,
    people: 0,
    peopleDropped: 0,
    members: 0,
    membersMissing: 0,
  };
  try {
    const ids = new Map<string, string>();
    const rowMaps = new Map<string, Map<string, string>>();
    if (input.restoreMembers && parsed.members?.length) {
      await restoreMembers(db, userId, created.id, parsed.members, report);
    }
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
      done += 1;
      await input.onProgress?.(done, total);
    }

    for (const table of parsed.tables) {
      const tableId = ids.get(table.key);
      if (!tableId || !table.rows?.length) continue;
      const { engine, rows } = await loadEngine(db, tableId, () => true);
      const physical = rows.tables.find((item) => item.id === tableId);
      if (!physical) continue;
      const columns = writeColumns(engine).filter(
        (column) => parsed.version >= 2 || column.fieldType !== "user",
      );
      const writable = new Set(columns.map((column) => column.name));
      const typed = (type: FieldType) =>
        new Set(
          columns
            .filter((column) => column.fieldType === type)
            .map((column) => column.name),
        );
      const fileColumns = typed("attachment");
      const userColumns = typed("user");
      const stored = await restoreFiles(db, files, userId, {
        tableId,
        rows: table.rows,
        fileColumns,
        readFile: input.readFile,
        maxBytes: input.maxFileBytes ?? DEFAULT_ATTACHMENT_MAX_BYTES,
        report,
      });
      const values = table.rows.map((row) =>
        Object.fromEntries(
          Object.entries(row).flatMap(
            ([key, value]): Array<[string, CellValue]> => {
              if (key === "__id" || !writable.has(key)) return [];
              if (fileColumns.has(key)) {
                const keys = fileRefs(value).flatMap((ref) => {
                  const found = stored.get(ref.file);
                  return found ? [found] : [];
                });
                return [[key, keys.length > 0 ? keys : null]];
              }
              if (userColumns.has(key)) {
                const listed = Array.isArray(value)
                  ? value.filter(
                      (item): item is string => typeof item === "string",
                    )
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
            },
          ),
        ),
      );
      const newIds = await insertNativeBatch(
        db,
        engine,
        writeContext(userId, physical),
        values,
      );
      const map = new Map<string, string>();
      table.rows.forEach((row, index) => {
        const oldId = typeof row.__id === "string" ? row.__id : undefined;
        const newId = newIds[index];
        if (oldId && newId) map.set(oldId, newId);
      });
      rowMaps.set(table.key, map);
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
      if (link.links?.length) {
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
      done += 1;
      await input.onProgress?.(done, total);
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
      done += 1;
      await input.onProgress?.(done, total);
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
 * each once, checked by the archive, thumbnails made as on upload.
 * Returns their new keys by snapshot id.
 */
async function restoreFiles(
  db: Database,
  files: FileStore,
  userId: string,
  input: {
    tableId: string;
    rows: NonNullable<SnapshotTable["rows"]>;
    fileColumns: ReadonlySet<string>;
    readFile:
      | ((id: string, maxBytes: number) => Promise<Buffer | undefined>)
      | undefined;
    maxBytes: number;
    report: SnapshotImportReport;
  },
): Promise<Map<string, string>> {
  const wanted = new Map<string, string>();
  for (const row of input.rows) {
    for (const name of input.fileColumns) {
      for (const ref of fileRefs(row[name])) {
        if (!wanted.has(ref.file)) wanted.set(ref.file, ref.name);
      }
    }
  }
  const stored = new Map<string, string>();
  for (const [id, name] of wanted) {
    let bytes: Buffer | undefined;
    try {
      bytes = await input.readFile?.(id, input.maxBytes);
    } catch {
      bytes = undefined;
    }
    if (!bytes) {
      input.report.filesMissing += 1;
      continue;
    }
    const meta = await storeAttachment(db, files, {
      tableId: input.tableId,
      userId,
      filename: cleanFilename(name),
      bytes,
    });
    stored.set(id, meta.key);
    input.report.files += 1;
  }
  return stored;
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
