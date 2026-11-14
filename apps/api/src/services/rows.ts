/**
 * Row writes, shared by every transport (ADR 0022): the web app's tRPC
 * routers, the public REST API, automations, and public forms. A transport
 * authenticates, validates the shape of its input, builds a `RowScope`, and
 * calls one of these functions. Field and row rules, required values, link
 * checks, change reasons, attachment ownership, and change announcements
 * live here only.
 */
import {
  AppError,
  assertRequiredValues,
  type AuditRole,
  type Binding,
  type CellValue,
  effectiveTableRole,
  type EngineCatalog,
  type EngineColumn,
  placeTarget,
  resolveChangeReason,
  roleAllows,
  type RowPlace,
} from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { assertAttachmentKeys } from "../attachments.js";
import { DUMMY_PASSWORD_HASH, verifyPassword } from "../auth/argon2.js";
import { readerEngine } from "../data/acl.js";
import { announceRows, type AnnounceDeps } from "../data/announce.js";
import type { CatalogRows, TableRow } from "../data/engine.js";
import { liveBase, liveTable } from "../data/live.js";
import { setLinks } from "../data/relations.js";
import {
  assertFieldsWritable,
  assertRowsInScope,
  deleteRows as deleteRowRecords,
  hasRules,
  insertRows,
  moveRows as moveRowRecords,
  restoreRows as restoreRowRecords,
  readByIds,
  setRowStatus,
  signRow,
  updateRows as updateRowRecords,
  visibleFields,
  type WriteContext,
  type RowRecord,
} from "../data/rows.js";
import { setExternalStatus, signExternalRow } from "../sources/statuses.js";
import {
  restoreExternalRows,
  deleteExternalRows,
  insertExternalRows,
  updateExternalRows,
  type ExternalWriteContext,
} from "../sources/writes.js";
import { assertLinksInSelection } from "../data/link-selection.js";

export type RowServiceDeps = AnnounceDeps & { db: Database };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Who writes, and the table as they see it. */
export type RowScope = {
  actorId: string;
  /** The actor's roles; links to other tables need them. */
  bindings?: readonly Binding[];
  table: TableRow;
  engine: EngineCatalog;
  catalog: CatalogRows;
};

export type WriteMeta = {
  /** The reason the person gave, checked against fields that require one. */
  reason?: string;
  /**
   * A reason fixed by the caller, recorded as it is: an automation's name,
   * or none for a public form, which cannot ask for one.
   */
  fixedReason?: string | null;
  /** web, api, restore, form:<id>, automation:<id>. */
  source: string;
  /** How many automations led to this write. */
  depth?: number;
  /**
   * A public form's link: the answer may carry only files that link sent,
   * claimed with the row (ADR 0062).
   */
  stagedShareId?: string;
};

export type LinkWrite = { column: string; targetIds: readonly string[] };

export type RowInput = {
  values: Readonly<Record<string, CellValue>>;
  links?: readonly LinkWrite[];
};

export type RowUpdate = RowInput & {
  rowId: string;
  /**
   * What the writer saw in the fields they change. A client's table
   * compares it under lock and refuses the write when it moved; AnyGridDB's
   * own tables do not need it.
   */
  expected?: Readonly<Record<string, CellValue>> | undefined;
};

/** A live table, or undefined when it or its base is in the trash. */
export async function findLiveTable(
  db: Database,
  tableId: string,
): Promise<TableRow | undefined> {
  return db
    .selectFrom("dataTables as t")
    .innerJoin("bases as b", "b.id", "t.baseId")
    .selectAll("t")
    .where("t.id", "=", tableId)
    .where(liveTable("t"))
    .where(liveBase("b"))
    .executeTakeFirst();
}

/** The table as `actor` sees it: their roles, and their field and row rules. */
export async function loadRowScope(
  db: Database,
  actor: { userId: string; bindings: readonly Binding[] },
  table: TableRow,
): Promise<RowScope> {
  const { engine, rows } = await readerEngine(db, table.id, {
    userId: actor.userId,
    bindings: [...actor.bindings],
  });
  return {
    actorId: actor.userId,
    bindings: actor.bindings,
    table,
    engine,
    catalog: rows,
  };
}

function resolveReason(
  scope: RowScope,
  touched: readonly string[] | "all",
  meta: WriteMeta,
): string | null {
  if (meta.fixedReason !== undefined) return meta.fixedReason;
  const own = scope.catalog.columns.filter(
    (column) => column.tableId === scope.table.id,
  );
  return resolveChangeReason(own, touched, meta.reason);
}

function writeContext(
  scope: RowScope,
  reason: string | null,
  meta: WriteMeta,
): WriteContext {
  return {
    userId: scope.actorId,
    tableId: scope.table.id,
    physicalName: scope.table.physicalName,
    baseId: scope.table.baseId,
    reason,
    source: meta.source,
    depth: meta.depth ?? 0,
  };
}

function touchedColumns(rows: readonly RowInput[]): string[] {
  return [
    ...new Set(
      rows.flatMap((row) => [
        ...Object.keys(row.values),
        ...(row.links ?? []).map((link) => link.column),
      ]),
    ),
  ];
}

/** The tables a write's links point to: their inverse links moved. */
function linkedTables(
  rows: readonly RowInput[],
  checked: ReadonlyMap<string, EngineColumn>,
): string[] {
  return [
    ...new Set(
      rows.flatMap((row) =>
        (row.links ?? []).flatMap((link) => {
          const target = checked.get(link.column)?.relation?.targetTableId;
          return target ? [target] : [];
        }),
      ),
    ),
  ];
}

/** The attachment keys these values write. */
function attachmentKeys(scope: RowScope, rows: readonly RowInput[]): string[] {
  const names = scope.engine.table.columns
    .filter((column) => column.fieldType === "attachment")
    .map((column) => column.name);
  return rows.flatMap((row) =>
    names.flatMap((name) => {
      const value = row.values[name];
      return Array.isArray(value)
        ? value.filter((key): key is string => typeof key === "string")
        : [];
    }),
  );
}

/**
 * Attachment keys written in these values must belong to the table; a
 * public form's answer may carry only the files its link sent.
 */
async function assertAttachments(
  db: Database,
  scope: RowScope,
  rows: readonly RowInput[],
  stagedShareId: string | undefined,
): Promise<void> {
  await assertAttachmentKeys(
    db,
    scope.table.id,
    attachmentKeys(scope, rows),
    stagedShareId,
  );
}

function relationColumn(scope: RowScope, name: string): EngineColumn {
  const column = scope.engine.table.columns.find((item) => item.name === name);
  if (!column?.relation) throw new AppError("invalid_relation");
  return column;
}

/**
 * A link may change only rows the actor can see on the other side. An
 * inverse one-to-many link writes the other table's foreign key, so it
 * also needs write access there, and that key must be writable.
 */
async function assertLinkAllowed(
  deps: RowServiceDeps,
  scope: RowScope,
  link: LinkWrite,
): Promise<EngineColumn> {
  const column = relationColumn(scope, link.column);
  const relation = column.relation;
  if (!relation) throw new AppError("invalid_relation");
  const writesOther =
    relation.direction === "inverse" && relation.kind === "one_to_many";
  const targetTable = await findLiveTable(deps.db, relation.targetTableId);
  const role =
    targetTable && scope.bindings
      ? effectiveTableRole(
          [...scope.bindings],
          targetTable.id,
          targetTable.baseId,
        )
      : undefined;
  if (!role || !roleAllows(role, writesOther ? "write" : "read")) {
    throw new AppError("access_denied");
  }
  const target = scope.engine.tables.get(relation.targetTableId);
  if (target) {
    const targetEngine = { ...scope.engine, table: target };
    await assertRowsInScope(deps.db, targetEngine, link.targetIds);
    if (writesOther && relation.fkColumn) {
      assertFieldsWritable(targetEngine, [relation.fkColumn]);
    }
  }
  return column;
}

async function writeLinks(
  deps: RowServiceDeps,
  scope: RowScope,
  rowId: string,
  links: readonly LinkWrite[],
  checked: ReadonlyMap<string, EngineColumn>,
  reason: string | null,
  meta: WriteMeta,
): Promise<string[]> {
  const touched: string[] = [];
  for (const link of links) {
    const column = checked.get(link.column);
    if (!column?.relation) throw new AppError("invalid_relation");
    const result = await setLinks(deps.db, scope.engine, {
      userId: scope.actorId,
      tableId: scope.table.id,
      physicalName: scope.table.physicalName,
      column,
      rowId,
      targetIds: link.targetIds,
      reason,
      source: meta.source,
      depth: meta.depth ?? 0,
    });
    touched.push(column.relation.targetTableId, ...result.touchedTables);
  }
  return touched;
}

/** Checks every rule a write must satisfy before anything is written. */
async function prepare(
  deps: RowServiceDeps,
  scope: RowScope,
  rows: readonly RowInput[],
  existing: readonly string[],
  stagedShareId?: string,
): Promise<Map<string, EngineColumn>> {
  assertFieldsWritable(scope.engine, touchedColumns(rows));
  assertRequiredValues(
    scope.catalog.columns.filter((column) => column.tableId === scope.table.id),
    rows.map((row) => row.values),
    existing.length > 0 ? "update" : "insert",
  );
  if (existing.length > 0) {
    await assertRowsInScope(deps.db, scope.engine, existing);
  }
  const checked = new Map<string, EngineColumn>();
  for (const row of rows) {
    for (const link of row.links ?? []) {
      checked.set(link.column, await assertLinkAllowed(deps, scope, link));
    }
  }
  await assertSelections(deps, scope, rows, existing, checked);
  await assertAttachments(deps.db, scope, rows, stagedShareId);
  return checked;
}

/**
 * A link field limited to a view or a filter accepts no new link outside
 * it; the links each row already has stay (`rows` match `existing` by
 * place, and a new row has none).
 */
async function assertSelections(
  deps: RowServiceDeps,
  scope: RowScope,
  rows: readonly RowInput[],
  existing: readonly string[],
  checked: ReadonlyMap<string, EngineColumn>,
): Promise<void> {
  const limited = [...checked.values()].filter(
    (column) => column.config.selectFrom !== undefined,
  );
  if (limited.length === 0) return;
  const current = new Map<string, RowRecord>();
  if (existing.length > 0) {
    const read = await readByIds(
      deps.db,
      scope.engine,
      existing,
      "UTC",
      limited.map((column) => column.name),
    );
    for (const row of read) current.set(row.id, row);
  }
  for (const column of limited) {
    const added = rows.flatMap((row, index) => {
      const link = row.links?.find((item) => item.column === column.name);
      if (!link) return [];
      const id = existing[index];
      const had = new Set(
        linkIds(id === undefined ? undefined : current.get(id)?.[column.name]),
      );
      return link.targetIds.filter((target) => !had.has(target));
    });
    await assertLinksInSelection(deps.db, scope.engine, column, added);
  }
}

/** The ids of a link cell's value. */
function linkIds(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap((item) =>
        item && typeof item === "object" && "id" in item
          ? [String((item as { id: unknown }).id)]
          : [],
      )
    : [];
}

function isExternal(scope: RowScope): boolean {
  return scope.table.storage === "external";
}

function externalContext(
  scope: RowScope,
  reason: string | null,
  meta: WriteMeta,
): ExternalWriteContext {
  return {
    userId: scope.actorId,
    table: scope.table,
    engine: scope.engine,
    catalog: scope.catalog,
    reason,
    source: meta.source,
    depth: meta.depth ?? 0,
  };
}

/**
 * A client's link is its own foreign key (ADR 0006): a row points to one
 * row at most, written as a value of that column.
 */
function withLinks(
  scope: RowScope,
  row: RowInput,
): Readonly<Record<string, CellValue>> {
  if (!row.links?.length) return row.values;
  const values: Record<string, CellValue> = { ...row.values };
  for (const link of row.links) {
    const relation = relationColumn(scope, link.column).relation;
    if (
      relation?.kind !== "one_to_many" ||
      relation.direction !== "forward" ||
      link.targetIds.length > 1
    ) {
      throw new AppError("invalid_relation");
    }
    values[link.column] = link.targetIds[0] ?? null;
  }
  return values;
}

/**
 * A client's inverse link is the other table's foreign key (ADR 0006):
 * linking a row sets the key on each row added, unlinking clears it on
 * each row removed. Those rows change through their own table's write
 * path, so its switches, rules, statuses, and trail apply.
 */
async function writeInverseLinks(
  deps: RowServiceDeps,
  scope: RowScope,
  rowId: string,
  link: LinkWrite,
  meta: WriteMeta,
): Promise<void> {
  const column = await assertLinkAllowed(deps, scope, link);
  const relation = column.relation;
  const targetTable = relation
    ? await findLiveTable(deps.db, relation.targetTableId)
    : undefined;
  if (!relation?.fkColumn || !targetTable || !scope.bindings) {
    throw new AppError("invalid_relation");
  }
  const target = await loadRowScope(
    deps.db,
    { userId: scope.actorId, bindings: scope.bindings },
    targetTable,
  );
  const foreignKey = target.engine.table.columns.find(
    (item) =>
      item.relation?.direction === "forward" &&
      item.physical?.name === relation.fkColumn,
  );
  if (!foreignKey) throw new AppError("invalid_relation");
  const [own] = await readByIds(deps.db, scope.engine, [rowId], "UTC", [
    link.column,
  ]);
  if (!own) throw new AppError("source_row_missing");
  const current = (
    Array.isArray(own[link.column]) ? own[link.column] : []
  ) as Array<{ id: string }>;
  const before = new Set(current.map((item) => item.id));
  const after = new Set(link.targetIds);
  await assertLinksInSelection(
    deps.db,
    scope.engine,
    column,
    [...after].filter((id) => !before.has(id)),
  );
  const updates: RowUpdate[] = [
    ...[...after]
      .filter((id) => !before.has(id))
      .map((id) => ({ rowId: id, values: { [foreignKey.name]: rowId } })),
    ...[...before]
      .filter((id) => !after.has(id))
      .map((id) => ({ rowId: id, values: { [foreignKey.name]: null } })),
  ];
  if (updates.length === 0) return;
  await updateRows(deps, target, updates, meta);
  await announceRows(deps, scope.table.id, "update", [rowId], []);
}

/**
 * The row a new or moved row is put beside must be one the writer sees,
 * in a table of AnyGridDB's own: a client's table keeps the order its
 * database gives it.
 */
async function assertPlace(
  deps: RowServiceDeps,
  scope: RowScope,
  place: RowPlace,
): Promise<void> {
  if (isExternal(scope)) throw new AppError("external_action_unavailable");
  await assertRowsInScope(deps.db, scope.engine, [placeTarget(place).rowId]);
}

/** New rows, at the end of the table, or together beside a row. */
export async function createRows(
  deps: RowServiceDeps,
  scope: RowScope,
  rows: readonly RowInput[],
  meta: WriteMeta,
  place?: RowPlace,
): Promise<string[]> {
  if (place) await assertPlace(deps, scope, place);
  const checked = await prepare(deps, scope, rows, [], meta.stagedShareId);
  const reason = resolveReason(scope, touchedColumns(rows), meta);
  if (isExternal(scope)) {
    const ids = await insertExternalRows(
      deps.db,
      externalContext(scope, reason, meta),
      rows.map((row) => withLinks(scope, row)),
    );
    await announceRows(
      deps,
      scope.table.id,
      "insert",
      ids,
      linkedTables(rows, checked),
    );
    return ids;
  }
  const ids = await insertRows(
    deps.db,
    scope.engine,
    {
      ...writeContext(scope, reason, meta),
      ...(meta.stagedShareId
        ? {
            claim: {
              shareId: meta.stagedShareId,
              keys: attachmentKeys(scope, rows),
            },
          }
        : {}),
    },
    rows.map((row) => row.values),
    place,
  );
  const extra: string[] = [];
  for (const [index, row] of rows.entries()) {
    const id = ids[index];
    if (!id || !row.links?.length) continue;
    extra.push(
      ...(await writeLinks(deps, scope, id, row.links, checked, reason, meta)),
    );
  }
  await announceRows(deps, scope.table.id, "insert", ids, extra);
  return ids;
}

export async function updateRows(
  deps: RowServiceDeps,
  scope: RowScope,
  updates: readonly RowUpdate[],
  meta: WriteMeta,
): Promise<string[]> {
  const rowIds = updates.map((update) => update.rowId);
  const checked = await prepare(deps, scope, updates, rowIds);
  const touched = touchedColumns(updates);
  const reason = resolveReason(scope, touched, meta);
  if (isExternal(scope)) {
    const ids = await updateExternalRows(
      deps.db,
      externalContext(scope, reason, meta),
      updates.map((update) => ({
        rowId: update.rowId,
        values: withLinks(scope, update),
        expected: update.expected,
      })),
    );
    await announceRows(
      deps,
      scope.table.id,
      "update",
      ids,
      linkedTables(updates, checked),
    );
    return ids;
  }
  const written = await updateRowRecords(
    deps.db,
    scope.engine,
    writeContext(scope, reason, meta),
    updates.map((update) => ({ rowId: update.rowId, values: update.values })),
  );
  const extra: string[] = [];
  for (const update of updates) {
    if (!update.links?.length) continue;
    extra.push(
      ...(await writeLinks(
        deps,
        scope,
        update.rowId,
        update.links,
        checked,
        reason,
        meta,
      )),
    );
  }
  const ids = [
    ...new Set([
      ...written,
      ...updates
        .filter((update) => update.links?.length)
        .map((update) => update.rowId),
    ]),
  ];
  await announceRows(deps, scope.table.id, "update", ids, extra);
  return ids;
}

/**
 * Puts rows just before or just after another, keeping the order they had
 * among themselves. Nothing in them changes: no webhook, automation, or
 * notification hears of it, and open tabs read the table again.
 */
export async function moveRows(
  deps: RowServiceDeps,
  scope: RowScope,
  rowIds: readonly string[],
  place: RowPlace,
  meta: WriteMeta,
): Promise<string[]> {
  await assertPlace(deps, scope, place);
  await assertRowsInScope(deps.db, scope.engine, rowIds);
  const ids = await moveRowRecords(
    deps.db,
    {
      ...writeContext(scope, resolveReason(scope, [], meta), meta),
      events: false,
    },
    rowIds,
    place,
  );
  await announceRows(deps, scope.table.id, "refresh", ids, []);
  return ids;
}

export async function deleteRows(
  deps: RowServiceDeps,
  scope: RowScope,
  rowIds: readonly string[],
  meta: WriteMeta,
): Promise<string[]> {
  await assertRowsInScope(deps.db, scope.engine, rowIds);
  const reason = resolveReason(scope, "all", meta);
  if (isExternal(scope)) {
    const ids = await deleteExternalRows(
      deps.db,
      externalContext(scope, reason, meta),
      rowIds,
      visibleFields(scope.engine) ??
        scope.engine.table.columns.map((column) => column.name),
    );
    await announceRows(deps, scope.table.id, "delete", ids, []);
    return ids;
  }
  const ids = await deleteRowRecords(
    deps.db,
    writeContext(scope, reason, meta),
    rowIds,
  );
  await announceRows(deps, scope.table.id, "delete", ids, []);
  return ids;
}

/**
 * A deleted row is kept whole. A collaborator with field or row rules
 * sees and restores only the rows they deleted themselves, which were in
 * their reach; a client's table keeps its trash for those without rules.
 */
export function trashScope(scope: {
  actorId: string;
  table: TableRow;
  engine: EngineCatalog;
}): string | undefined {
  if (!hasRules(scope.engine)) return undefined;
  if (scope.table.storage === "external") throw new AppError("access_denied");
  return scope.actorId;
}

export async function restoreRows(
  deps: RowServiceDeps,
  scope: RowScope,
  rowIds: readonly string[],
  meta: WriteMeta,
): Promise<string[]> {
  const deletedBy = trashScope(scope);
  const reason = resolveReason(scope, "all", meta);
  if (isExternal(scope)) {
    // Added again from what the delete recorded, best effort (ADR 0007).
    const ids = await restoreExternalRows(
      deps.db,
      externalContext(scope, reason, meta),
      rowIds,
    );
    await announceRows(deps, scope.table.id, "insert", ids, []);
    return ids;
  }
  if (rowIds.some((id) => !UUID.test(id))) {
    throw new AppError("invalid_row_id");
  }
  const ids = await restoreRowRecords(
    deps.db,
    scope.engine,
    writeContext(scope, reason, meta),
    rowIds,
    deletedBy,
  );
  await announceRows(deps, scope.table.id, "insert", ids, []);
  return ids;
}

/** Replaces the links of one row in one relation column. */
export async function replaceLinks(
  deps: RowServiceDeps,
  scope: RowScope,
  rowId: string,
  link: LinkWrite,
  meta: WriteMeta,
): Promise<void> {
  if (isExternal(scope)) {
    const relation = relationColumn(scope, link.column).relation;
    if (relation?.direction === "inverse" && relation.kind === "one_to_many") {
      await writeInverseLinks(deps, scope, rowId, link, meta);
      return;
    }
    await updateRows(deps, scope, [{ rowId, values: {}, links: [link] }], meta);
    return;
  }
  const checked = await prepare(
    deps,
    scope,
    [{ values: {}, links: [link] }],
    [rowId],
  );
  const reason = resolveReason(scope, [link.column], meta);
  const extra = await writeLinks(
    deps,
    scope,
    rowId,
    [link],
    checked,
    reason,
    meta,
  );
  await announceRows(deps, scope.table.id, "update", [rowId], extra);
}

/** Submits, locks, or unlocks a row; `role` decides which moves are allowed. */
export async function changeStatus(
  deps: RowServiceDeps,
  scope: RowScope & { role: AuditRole },
  rowId: string,
  status: "submitted" | "locked" | "draft",
  meta: WriteMeta,
): Promise<void> {
  await assertRowsInScope(deps.db, scope.engine, [rowId]);
  if (isExternal(scope)) {
    // Kept by AnyGridDB, sealed by a fingerprint (ADR 0033).
    await setExternalStatus(deps.db, {
      userId: scope.actorId,
      role: scope.role,
      table: scope.table,
      rowId,
      status,
      source: meta.source,
      depth: meta.depth ?? 0,
    });
    await announceRows(deps, scope.table.id, "update", [rowId], []);
    return;
  }
  if (!UUID.test(rowId)) throw new AppError("invalid_row_id");
  await setRowStatus(deps.db, {
    userId: scope.actorId,
    role: scope.role,
    table: scope.table,
    rowId,
    status,
    source: meta.source,
    depth: meta.depth ?? 0,
  });
  await announceRows(deps, scope.table.id, "update", [rowId], []);
}

/**
 * Signs a locked row. The signer types their password again: a signature
 * stands for the person, not for whoever holds their session.
 */
export async function signRowAs(
  deps: RowServiceDeps,
  scope: RowScope,
  input: { rowId: string; password: string; meaning: string },
  meta: WriteMeta,
): Promise<void> {
  if (!isExternal(scope) && !UUID.test(input.rowId)) {
    throw new AppError("invalid_row_id");
  }
  await assertRowsInScope(deps.db, scope.engine, [input.rowId]);
  const stored = await deps.db
    .selectFrom("passwordHashes")
    .select("hash")
    .where("userId", "=", scope.actorId)
    .executeTakeFirst();
  const verified = await verifyPassword(
    stored?.hash ?? DUMMY_PASSWORD_HASH,
    input.password,
  );
  if (!stored || !verified) throw new AppError("invalid_credentials");
  if (isExternal(scope)) {
    await signExternalRow(deps.db, {
      userId: scope.actorId,
      table: scope.table,
      rowId: input.rowId,
      meaning: input.meaning,
      source: meta.source,
      depth: meta.depth ?? 0,
    });
    await announceRows(deps, scope.table.id, "update", [input.rowId], []);
    return;
  }
  await signRow(deps.db, {
    userId: scope.actorId,
    table: scope.table,
    rowId: input.rowId,
    meaning: input.meaning,
    source: meta.source,
    depth: meta.depth ?? 0,
  });
  await announceRows(deps, scope.table.id, "update", [input.rowId], []);
}

/**
 * Native batch persistence for product jobs (import, copy, snapshot).
 * Jobs own their WriteContext events (one import summary, or none — ADR 0008).
 * Interactive transports must use createRows / updateRows / deleteRows.
 */
export async function insertNativeBatch(
  db: Database,
  engine: EngineCatalog,
  context: WriteContext,
  rows: ReadonlyArray<Readonly<Record<string, CellValue>>>,
): Promise<string[]> {
  return insertRows(db, engine, context, rows);
}

/**
 * Native batch updates for product jobs. Same contract as insertNativeBatch.
 */
export async function updateNativeBatch(
  db: Database,
  engine: EngineCatalog,
  context: WriteContext,
  updates: ReadonlyArray<{
    rowId: string;
    values: Readonly<Record<string, CellValue>>;
  }>,
): Promise<string[]> {
  return updateRowRecords(db, engine, context, updates);
}
