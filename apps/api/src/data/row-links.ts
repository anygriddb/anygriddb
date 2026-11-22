/**
 * What deleting a row does to the rows linked to it, and what restoring it
 * brings back. The database would clear a foreign key and drop a junction's
 * row by itself, out of the other row's sight: here each removal is written
 * under the table of the row it changes, a locked or signed row refuses it,
 * and what a restore needs is kept beside the delete.
 */
import {
  AppError,
  buildExistingIds,
  buildInsertLinks,
  buildReadCells,
  buildReadHolders,
  buildReadJunction,
  buildReadJunctionRows,
  buildReadReferencing,
  buildReadReferencingIds,
  buildReadStatuses,
  buildSetForeignKeys,
} from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { sql } from "kysely";
import { runRows, type AuditTx } from "./audit-context.js";

/** Marker of a post-delete event: the many-to-many links of the row. */
const JUNCTIONS_KEPT = "__ag_m2m";
/** In the same marker: the rows whose key pointed to it. */
const HOLDERS_KEPT = "__ag_fk";
/** A marker written after the delete names the delete it completes. */
const FOR_DELETE = "__ag_for";

type Side = "left_id" | "right_id";

/** Links of one row in one junction: the rows on the other side. */
type SavedLinks = { junction: string; side: Side; ids: string[] };

/** The rows whose key, in one field, pointed to a deleted row. */
export type SavedHolders = { column: string; ids: string[] };

export type KeptLinks = { junctions: SavedLinks[]; holders: SavedHolders[] };

type Junction = {
  junction: string;
  /** Where this table's rows sit in the junction. */
  side: Side;
  /** Physical table on the other side. */
  other: string;
  otherTableId: string;
  /** The field that shows the link there; a one-way link's target has none. */
  otherField: string | null;
};

/** A foreign key of another table (or this one) that points to this table. */
type Holder = {
  columnId: string;
  column: string;
  tableId: string;
  physical: string;
};

/** A foreign key of this table. */
type OwnKey = {
  column: string;
  tableId: string;
  physical: string;
  /** The field of the row it points to that lists this one, if any. */
  inverseField: string | null;
};

export type LinkMap = {
  junctions: Junction[];
  holders: Holder[];
  ownKeys: OwnKey[];
};

/** Who writes, for the events written by hand beside the triggers'. */
export type LinkWriter = {
  userId: string;
  tableId: string;
  physicalName: string;
  reason: string | null;
  source: string;
};

/** True for the internal event that keeps a deleted row's links. */
export function isLinkMarker(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JUNCTIONS_KEPT in value
  );
}

export function assertWritable(status: unknown): void {
  if (status === "locked" || status === "signed") {
    throw new AppError("row_locked");
  }
}

/**
 * Every link a row of `tableId` can take part in, on a table of AnyGridDB's
 * own. Link fields in the trash count too: their storage, and the links a
 * restore must bring back, are kept.
 */
export async function linkMapOf(
  db: Database,
  tableId: string,
): Promise<LinkMap> {
  const found = await db
    .selectFrom("relations as r")
    .innerJoin("dataColumns as c", "c.id", "r.fromColumnId")
    .innerJoin("dataTables as s", "s.id", "c.tableId")
    .innerJoin("dataTables as t", "t.id", "r.toTableId")
    .leftJoin("dataColumns as v", "v.id", "r.inverseColumnId")
    .select([
      "r.kind",
      "r.junctionName as junction",
      "c.id as columnId",
      "c.name as column",
      "c.fieldType",
      "c.tableId as fromTable",
      "s.physicalName as fromPhysical",
      "s.storage as fromStorage",
      "r.toTableId as toTable",
      "t.physicalName as toPhysical",
      "t.storage as toStorage",
      "v.name as inverseName",
    ])
    .where((eb) =>
      eb.or([eb("c.tableId", "=", tableId), eb("r.toTableId", "=", tableId)]),
    )
    .execute();
  const map: LinkMap = { junctions: [], holders: [], ownKeys: [] };
  for (const row of found) {
    if (row.fromStorage !== "native" || row.toStorage !== "native") continue;
    if (row.kind === "many_to_many" && row.junction) {
      if (row.fromTable === tableId) {
        map.junctions.push({
          junction: row.junction,
          side: "left_id",
          other: row.toPhysical,
          otherTableId: row.toTable,
          otherField: row.inverseName,
        });
      }
      if (row.toTable === tableId) {
        map.junctions.push({
          junction: row.junction,
          side: "right_id",
          other: row.fromPhysical,
          otherTableId: row.fromTable,
          otherField: row.column,
        });
      }
    }
    // The other side of a two-way one-to-many link holds no key.
    if (
      row.kind === "one_to_many" &&
      row.fieldType === "relation_one_to_many"
    ) {
      if (row.toTable === tableId) {
        map.holders.push({
          columnId: row.columnId,
          column: row.column,
          tableId: row.fromTable,
          physical: row.fromPhysical,
        });
      }
      if (row.fromTable === tableId) {
        map.ownKeys.push({
          column: row.column,
          tableId: row.toTable,
          physical: row.toPhysical,
          inverseField: row.inverseName,
        });
      }
    }
  }
  return map;
}

/** Runs `write` with the row trigger filing its events under `tableId`. */
async function underTable<T>(
  tx: AuditTx,
  tableId: string,
  backTo: string,
  write: () => Promise<T>,
): Promise<T> {
  await sql`select set_config('anygrid.table_id', ${tableId}, true)`.execute(
    tx,
  );
  const result = await write();
  await sql`select set_config('anygrid.table_id', ${backTo}, true)`.execute(tx);
  return result;
}

/** Locks rows of `table` together; each one's status, by id. */
async function lockedStatuses(
  tx: AuditTx,
  table: string,
  ids: readonly string[],
): Promise<Map<string, string>> {
  const rows = await runRows(tx, buildReadStatuses({ table, ids: [...ids] }));
  return new Map(rows.map((row) => [String(row.id), String(row.ag_status)]));
}

/** What each of `ids` lists in a junction, read in one statement. */
async function junctionLists(
  tx: AuditTx,
  junction: Junction,
  ids: readonly string[],
): Promise<Map<string, string[]>> {
  const theirs: Side = junction.side === "left_id" ? "right_id" : "left_id";
  const rows = await runRows(
    tx,
    buildReadJunctionRows({
      junction: junction.junction,
      side: theirs,
      ids: [...ids],
    }),
  );
  const lists = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const row of rows) {
    lists.get(String(row[theirs]))?.push(String(row[junction.side]));
  }
  return lists;
}

/** A change of links on rows of another table, in that row's own history. */
async function recordLinkChanges(
  tx: AuditTx,
  who: LinkWriter,
  tableId: string,
  field: string,
  changes: ReadonlyArray<{
    rowId: string;
    before: readonly string[];
    after: readonly string[];
  }>,
): Promise<void> {
  if (changes.length === 0) return;
  await tx
    .insertInto("auditEvents")
    .values(
      changes.map((change) => ({
        userId: who.userId,
        action: "update" as const,
        tableId,
        recordId: change.rowId,
        oldValue: { [field]: [...change.before] },
        newValue: { [field]: [...change.after] },
        reason: who.reason,
        source: who.source,
      })),
    )
    .execute();
}

/**
 * Takes a row about to be deleted out of the rows linked to it, in the
 * delete's transaction. Refused while one of them that shows the link is
 * locked or signed: its content would change. A row that shows nothing of
 * the link (the target of a one-way link) is not asked.
 */
export async function detachLinks(
  tx: AuditTx,
  who: LinkWriter,
  map: LinkMap,
  rowId: string,
): Promise<{ kept: KeptLinks; touched: string[] }> {
  const kept: KeptLinks = { junctions: [], holders: [] };
  const touched = new Set<string>();

  for (const holder of map.holders) {
    const rows = await runRows(
      tx,
      buildReadReferencing({
        table: holder.physical,
        column: holder.column,
        targetId: rowId,
      }),
    );
    const others = rows.filter((row) => String(row.id) !== rowId);
    if (others.length === 0) continue;
    for (const row of others) assertWritable(row.ag_status);
    const ids = others.map((row) => String(row.id));
    await underTable(tx, holder.tableId, who.tableId, () =>
      runRows(
        tx,
        buildSetForeignKeys({
          table: holder.physical,
          column: holder.column,
          ids,
          targetId: null,
        }),
      ),
    );
    kept.holders.push({ column: holder.columnId, ids });
    touched.add(holder.tableId);
  }

  for (const junction of map.junctions) {
    const rows = await runRows(
      tx,
      buildReadJunction({
        junction: junction.junction,
        side: junction.side,
        id: rowId,
      }),
    );
    const far: Side = junction.side === "left_id" ? "right_id" : "left_id";
    const ids = rows.flatMap((row) =>
      typeof row[far] === "string" ? [row[far]] : [],
    );
    if (ids.length === 0) continue;
    kept.junctions.push({
      junction: junction.junction,
      side: junction.side,
      ids,
    });
    const others = ids.filter((id) => id !== rowId);
    if (junction.otherField === null || others.length === 0) continue;
    const statuses = await lockedStatuses(tx, junction.other, others);
    for (const status of statuses.values()) assertWritable(status);
    const lists = await junctionLists(tx, junction, others);
    await recordLinkChanges(
      tx,
      who,
      junction.otherTableId,
      junction.otherField,
      others.map((id) => {
        const before = lists.get(id) ?? [];
        return {
          rowId: id,
          before,
          after: before.filter((item) => item !== rowId),
        };
      }),
    );
    touched.add(junction.otherTableId);
  }

  const shown = map.ownKeys.filter((key) => key.inverseField !== null);
  if (shown.length > 0) {
    const [cells] = await runRows(
      tx,
      buildReadCells({
        table: who.physicalName,
        id: rowId,
        columns: shown.map((key) => key.column),
      }),
    );
    for (const key of shown) {
      const target = cells?.[key.column];
      if (typeof target !== "string" || target === rowId) continue;
      const statuses = await lockedStatuses(tx, key.physical, [target]);
      assertWritable(statuses.get(target));
      const siblings = await runRows(
        tx,
        buildReadReferencingIds({
          table: who.physicalName,
          column: key.column,
          targetId: target,
        }),
      );
      const before = siblings.map((row) => String(row.id));
      await recordLinkChanges(tx, who, key.tableId, key.inverseField ?? "", [
        {
          rowId: target,
          before,
          after: before.filter((id) => id !== rowId),
        },
      ]);
      touched.add(key.tableId);
    }
  }
  return { kept, touched: [...touched] };
}

/** The content of the event that keeps a row's links. */
export function linkMarker(
  kept: KeptLinks,
  forDelete?: string,
): { oldValue: Record<string, unknown>; newValue: Record<string, unknown> } {
  return {
    oldValue: {
      [JUNCTIONS_KEPT]: kept.junctions,
      [HOLDERS_KEPT]: kept.holders,
      ...(forDelete ? { [FOR_DELETE]: forDelete } : {}),
    },
    newValue: { [JUNCTIONS_KEPT]: [] },
  };
}

export function hasLinks(kept: KeptLinks): boolean {
  return kept.junctions.length > 0 || kept.holders.length > 0;
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((id) => typeof id === "string");
}

function savedJunctions(bag: unknown): SavedLinks[] {
  if (!Array.isArray(bag)) return [];
  return bag.flatMap((item): SavedLinks[] => {
    const entry = item as Partial<SavedLinks> | null;
    return entry &&
      typeof entry.junction === "string" &&
      (entry.side === "left_id" || entry.side === "right_id") &&
      strings(entry.ids)
      ? [{ junction: entry.junction, side: entry.side, ids: entry.ids }]
      : [];
  });
}

function savedHolders(bag: unknown): SavedHolders[] {
  if (!Array.isArray(bag)) return [];
  return bag.flatMap((item): SavedHolders[] => {
    const entry = item as Partial<SavedHolders> | null;
    return entry && typeof entry.column === "string" && strings(entry.ids)
      ? [{ column: entry.column, ids: entry.ids }]
      : [];
  });
}

/**
 * Links kept when each row was last deleted: the marker written in the
 * same transaction as the delete event, so it shares its timestamp, and
 * one written later that names that delete. An older marker belongs to an
 * earlier deletion and is ignored.
 */
export async function linksForRestore(
  db: Database,
  tableId: string,
  deletions: ReadonlyArray<{
    recordId: string;
    deletedAt: string;
    eventId: string;
  }>,
): Promise<Map<string, KeptLinks>> {
  if (deletions.length === 0) return new Map();
  const of = new Map(deletions.map((item) => [item.recordId, item]));
  const events = await db
    .selectFrom("auditEvents")
    .select(["recordId", "oldValue", "occurredAt"])
    .where("tableId", "=", tableId)
    .where("action", "=", "update")
    .where("recordId", "in", [...of.keys()])
    .orderBy("occurredAt", "desc")
    .limit(deletions.length * 8)
    .execute();
  const found = new Map<string, KeptLinks>();
  for (const event of events) {
    if (!event.recordId || !isLinkMarker(event.oldValue)) continue;
    const deletion = of.get(event.recordId);
    if (!deletion) continue;
    const marker = event.oldValue as Record<string, unknown>;
    const named = marker[FOR_DELETE];
    const belongs =
      named === undefined
        ? deletion.deletedAt === event.occurredAt.toISOString()
        : named === deletion.eventId;
    if (!belongs) continue;
    const links = found.get(event.recordId) ?? { junctions: [], holders: [] };
    links.junctions.push(...savedJunctions(marker[JUNCTIONS_KEPT]));
    links.holders.push(...savedHolders(marker[HOLDERS_KEPT]));
    found.set(event.recordId, links);
  }
  return found;
}

/** Whether rows deleted before this kept their holders has been made up. */
export function markerHasHolders(value: unknown): boolean {
  return (
    isLinkMarker(value) &&
    savedHolders((value as Record<string, unknown>)[HOLDERS_KEPT]).length > 0
  );
}

export function markerDelete(value: unknown): string | undefined {
  if (!isLinkMarker(value)) return undefined;
  const named = (value as Record<string, unknown>)[FOR_DELETE];
  return typeof named === "string" ? named : undefined;
}

/**
 * The foreign keys of rows about to come back: which each may keep. A key
 * whose target is gone, or locked or signed where it would show this row,
 * comes back empty; one pointing to a row of this same restore is written
 * once both are there.
 */
export async function planOwnKeys(
  tx: AuditTx,
  map: LinkMap,
  rows: ReadonlyArray<{
    recordId: string;
    snapshot: Record<string, unknown>;
  }>,
): Promise<{
  left: Map<string, Set<string>>;
  later: Array<{ rowId: string; column: string; targetId: string }>;
  refused: number;
}> {
  const coming = new Set(rows.map((row) => row.recordId));
  const left = new Map<string, Set<string>>();
  const later: Array<{ rowId: string; column: string; targetId: string }> = [];
  let refused = 0;
  const leave = (rowId: string, column: string) => {
    const columns = left.get(rowId) ?? new Set<string>();
    columns.add(column);
    left.set(rowId, columns);
  };
  for (const key of map.ownKeys) {
    const asked = new Set<string>();
    for (const row of rows) {
      const target = row.snapshot[key.column];
      if (
        typeof target === "string" &&
        target !== row.recordId &&
        !coming.has(target)
      ) {
        asked.add(target);
      }
    }
    const open = new Set<string>();
    const closed = new Set<string>();
    if (asked.size > 0) {
      if (key.inverseField === null) {
        const found = await runRows(
          tx,
          buildExistingIds({ table: key.physical, ids: [...asked] }),
        );
        for (const row of found) open.add(String(row.id));
      } else {
        const statuses = await lockedStatuses(tx, key.physical, [...asked]);
        for (const [id, status] of statuses) {
          (status === "locked" || status === "signed" ? closed : open).add(id);
        }
      }
    }
    for (const row of rows) {
      const target = row.snapshot[key.column];
      if (typeof target !== "string" || target === row.recordId) continue;
      if (coming.has(target)) {
        leave(row.recordId, key.column);
        later.push({
          rowId: row.recordId,
          column: key.column,
          targetId: target,
        });
      } else if (!open.has(target)) {
        leave(row.recordId, key.column);
        if (closed.has(target)) refused += 1;
      }
    }
  }
  return { left, later, refused };
}

/**
 * Puts a restored row back into the rows linked to it. A holder takes its
 * key again only while the key is still empty: one set since is a newer
 * choice. A row locked or signed since is left as it is, and counted.
 */
export async function reattachLinks(
  tx: AuditTx,
  who: LinkWriter,
  map: LinkMap,
  rowId: string,
  kept: KeptLinks,
): Promise<{ refused: number; touched: string[] }> {
  let refused = 0;
  const touched = new Set<string>();

  for (const saved of kept.holders) {
    const holder = map.holders.find((item) => item.columnId === saved.column);
    if (!holder || saved.ids.length === 0) continue;
    const rows = await runRows(
      tx,
      buildReadHolders({
        table: holder.physical,
        column: holder.column,
        ids: saved.ids,
      }),
    );
    const empty = rows.filter((row) => row.key === null);
    const free = empty.filter(
      (row) => row.ag_status !== "locked" && row.ag_status !== "signed",
    );
    refused += empty.length - free.length;
    if (free.length === 0) continue;
    await underTable(tx, holder.tableId, who.tableId, () =>
      runRows(
        tx,
        buildSetForeignKeys({
          table: holder.physical,
          column: holder.column,
          ids: free.map((row) => String(row.id)),
          targetId: rowId,
        }),
      ),
    );
    touched.add(holder.tableId);
  }

  for (const saved of kept.junctions) {
    const junction = map.junctions.find(
      (item) => item.junction === saved.junction && item.side === saved.side,
    );
    if (!junction || saved.ids.length === 0) continue;
    let alive: string[];
    if (junction.otherField === null) {
      const found = await runRows(
        tx,
        buildExistingIds({ table: junction.other, ids: saved.ids }),
      );
      alive = found.map((row) => String(row.id));
    } else {
      const statuses = await lockedStatuses(tx, junction.other, saved.ids);
      alive = [];
      for (const [id, status] of statuses) {
        if (id !== rowId && (status === "locked" || status === "signed")) {
          refused += 1;
        } else {
          alive.push(id);
        }
      }
    }
    if (alive.length === 0) continue;
    const others = alive.filter((id) => id !== rowId);
    const lists =
      junction.otherField !== null && others.length > 0
        ? await junctionLists(tx, junction, others)
        : new Map<string, string[]>();
    const own = alive.map(() => rowId);
    await runRows(
      tx,
      buildInsertLinks({
        junction: junction.junction,
        leftIds: saved.side === "left_id" ? own : alive,
        rightIds: saved.side === "left_id" ? alive : own,
      }),
    );
    if (junction.otherField !== null) {
      await recordLinkChanges(
        tx,
        who,
        junction.otherTableId,
        junction.otherField,
        others.flatMap((id) => {
          const before = lists.get(id) ?? [];
          return before.includes(rowId)
            ? []
            : [{ rowId: id, before, after: [...before, rowId] }];
        }),
      );
      touched.add(junction.otherTableId);
    }
  }
  return { refused, touched: [...touched] };
}

/** A key that came back, in the history of the row that lists it. */
export async function recordKeyReturn(
  tx: AuditTx,
  who: LinkWriter,
  key: OwnKey,
  rowId: string,
  targetId: string,
): Promise<void> {
  if (key.inverseField === null || targetId === rowId) return;
  const siblings = await runRows(
    tx,
    buildReadReferencingIds({
      table: who.physicalName,
      column: key.column,
      targetId,
    }),
  );
  const after = siblings.map((row) => String(row.id));
  await recordLinkChanges(tx, who, key.tableId, key.inverseField, [
    {
      rowId: targetId,
      before: after.filter((id) => id !== rowId),
      after,
    },
  ]);
}
