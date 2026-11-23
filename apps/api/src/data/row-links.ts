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
/** In a marker for a row still in the trash: the keys it takes back. */
const KEYS_KEPT = "__ag_keys";
/** Left by a restore for a row still in the trash, not read from the trail. */
const NOTE = "__ag_note";

type Side = "left_id" | "right_id";

/** Links of one row in one junction: the rows on the other side. */
type SavedLinks = { junction: string; side: Side; ids: string[] };

/** The rows whose key, in one field, pointed to a deleted row. */
export type SavedHolders = { column: string; ids: string[] };

/** A key a row in the trash takes again when it comes back. */
type SavedKey = { column: string; target: string };

export type KeptLinks = {
  junctions: SavedLinks[];
  holders: SavedHolders[];
  keys: SavedKey[];
};

export type Junction = {
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
export type OwnKey = {
  columnId: string;
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
          columnId: row.columnId,
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
 * A link of `rowId` in a junction about to be added or removed, as the rows
 * on the other side show it. Refused when one of them is locked or signed;
 * otherwise written in their own history. A row that shows nothing of the
 * link (the target of a one-way link) is not asked.
 */
export async function changeJunctionSide(
  tx: AuditTx,
  who: LinkWriter,
  junction: Junction,
  rowId: string,
  added: readonly string[],
  removed: readonly string[],
): Promise<void> {
  if (junction.otherField === null) return;
  const others = [...new Set([...added, ...removed])].filter(
    (id) => id !== rowId,
  );
  if (others.length === 0) return;
  const statuses = await lockedStatuses(tx, junction.other, others);
  for (const status of statuses.values()) assertWritable(status);
  const lists = await junctionLists(tx, junction, others);
  const adding = new Set(added);
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
        after: adding.has(id)
          ? [...before, rowId]
          : before.filter((item) => item !== rowId),
      };
    }),
  );
}

/**
 * The key of `rowId` about to move, as the rows it points to list it: the
 * same refusal and the same event, when the link is two-way.
 */
export async function changeKeySide(
  tx: AuditTx,
  who: LinkWriter,
  key: OwnKey,
  rowId: string,
  from: string | null,
  to: string | null,
): Promise<void> {
  if (key.inverseField === null || from === to) return;
  const parents = [from, to].flatMap((id) =>
    id !== null && id !== rowId ? [id] : [],
  );
  if (parents.length === 0) return;
  const statuses = await lockedStatuses(tx, key.physical, parents);
  for (const status of statuses.values()) assertWritable(status);
  for (const parent of parents) {
    const siblings = await runRows(
      tx,
      buildReadReferencingIds({
        table: who.physicalName,
        column: key.column,
        targetId: parent,
      }),
    );
    const before = siblings.map((row) => String(row.id));
    await recordLinkChanges(tx, who, key.tableId, key.inverseField, [
      {
        rowId: parent,
        before,
        after:
          parent === to
            ? [...before, rowId]
            : before.filter((id) => id !== rowId),
      },
    ]);
  }
}

/**
 * Holders about to leave the rows they point to for another, written from
 * that other row's side: the rows they leave list them, so each is asked
 * and keeps the change in its history.
 */
export async function leaveParents(
  tx: AuditTx,
  who: LinkWriter,
  parents: { physical: string; tableId: string; field: string },
  holders: { physical: string; column: string },
  leaving: ReadonlyMap<string, readonly string[]>,
): Promise<void> {
  const ids = [...leaving.keys()];
  if (ids.length === 0) return;
  const statuses = await lockedStatuses(tx, parents.physical, ids);
  for (const status of statuses.values()) assertWritable(status);
  for (const [parent, moved] of leaving) {
    const siblings = await runRows(
      tx,
      buildReadReferencingIds({
        table: holders.physical,
        column: holders.column,
        targetId: parent,
      }),
    );
    const before = siblings.map((row) => String(row.id));
    await recordLinkChanges(tx, who, parents.tableId, parents.field, [
      {
        rowId: parent,
        before,
        after: before.filter((id) => !moved.includes(id)),
      },
    ]);
  }
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
  const kept: KeptLinks = { junctions: [], holders: [], keys: [] };
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
    await changeJunctionSide(tx, who, junction, rowId, [], ids);
    if (junction.otherField !== null) touched.add(junction.otherTableId);
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
      await changeKeySide(tx, who, key, rowId, target, null);
      touched.add(key.tableId);
    }
  }
  return { kept, touched: [...touched] };
}

/** The content of the event that keeps a row's links. */
export function linkMarker(
  kept: KeptLinks,
  forDelete?: string,
  note = false,
): { oldValue: Record<string, unknown>; newValue: Record<string, unknown> } {
  return {
    oldValue: {
      [JUNCTIONS_KEPT]: kept.junctions,
      [HOLDERS_KEPT]: kept.holders,
      ...(kept.keys.length > 0 ? { [KEYS_KEPT]: kept.keys } : {}),
      ...(forDelete ? { [FOR_DELETE]: forDelete } : {}),
      ...(note ? { [NOTE]: true } : {}),
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

function savedKeys(bag: unknown): SavedKey[] {
  if (!Array.isArray(bag)) return [];
  return bag.flatMap((item): SavedKey[] => {
    const entry = item as Partial<SavedKey> | null;
    return entry &&
      typeof entry.column === "string" &&
      typeof entry.target === "string"
      ? [{ column: entry.column, target: entry.target }]
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
  const oldest = deletions.reduce(
    (first, item) => (item.deletedAt < first ? item.deletedAt : first),
    deletions[0]?.deletedAt ?? "",
  );
  // Only the markers, from the first of these deletes on: a row linked to
  // many others may have one for each that came back before it.
  const events = await db
    .selectFrom("auditEvents")
    .select(["recordId", "oldValue", "occurredAt"])
    .where("tableId", "=", tableId)
    .where("action", "=", "update")
    .where("recordId", "in", [...of.keys()])
    .where("occurredAt", ">=", new Date(oldest))
    .where(sql<boolean>`jsonb_exists(old_value, ${JUNCTIONS_KEPT})`)
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
    const links = found.get(event.recordId) ?? {
      junctions: [],
      holders: [],
      keys: [],
    };
    links.junctions.push(...savedJunctions(marker[JUNCTIONS_KEPT]));
    links.holders.push(...savedHolders(marker[HOLDERS_KEPT]));
    links.keys.push(...savedKeys(marker[KEYS_KEPT]));
    found.set(event.recordId, links);
  }
  return found;
}

/** Whether rows deleted before this kept their holders has been made up. */
export function markerHasHolders(value: unknown): boolean {
  if (!isLinkMarker(value)) return false;
  const marker = value as Record<string, unknown>;
  return !marker[NOTE] && savedHolders(marker[HOLDERS_KEPT]).length > 0;
}

export function markerDelete(value: unknown): string | undefined {
  if (!isLinkMarker(value)) return undefined;
  const named = (value as Record<string, unknown>)[FOR_DELETE];
  return typeof named === "string" ? named : undefined;
}

/**
 * What a restore leaves for a row still in the trash: written beside that
 * row's last delete, so that the link comes back with whichever returns
 * last. A row with no delete on the trail is gone for good, and gets none.
 */
async function noteForTrashed(
  tx: AuditTx,
  who: LinkWriter,
  tableId: string,
  notes: ReadonlyMap<string, KeptLinks>,
): Promise<void> {
  if (notes.size === 0) return;
  const deletes = await tx
    .selectFrom("auditEvents")
    .select(["id", "recordId"])
    .where("tableId", "=", tableId)
    .where("action", "=", "delete")
    .where("recordId", "in", [...notes.keys()])
    .orderBy("writeOrder", (order) => order.desc().nullsLast())
    .orderBy("occurredAt", "desc")
    .execute();
  const latest = new Map<string, string>();
  for (const event of deletes) {
    if (event.recordId && !latest.has(event.recordId)) {
      latest.set(event.recordId, event.id);
    }
  }
  const values = [...notes].flatMap(([recordId, kept]) => {
    const deleted = latest.get(recordId);
    return deleted
      ? [
          {
            userId: who.userId,
            action: "update" as const,
            tableId,
            recordId,
            ...linkMarker(kept, deleted, true),
            reason: who.reason,
            source: who.source,
          },
        ]
      : [];
  });
  if (values.length > 0)
    await tx.insertInto("auditEvents").values(values).execute();
}

/**
 * The foreign keys of rows about to come back: which each may keep. A key
 * whose target is locked or signed where it would show this row comes back
 * empty and is counted. One whose target is still in the trash comes back
 * empty too, and is noted there for when it returns. One pointing to a row
 * of this same restore, or noted while this row was away, is written once
 * every row is back.
 */
export async function planOwnKeys(
  tx: AuditTx,
  who: LinkWriter,
  map: LinkMap,
  rows: ReadonlyArray<{
    recordId: string;
    snapshot: Record<string, unknown>;
  }>,
  noted: ReadonlyMap<string, KeptLinks>,
  /** The fields a restored row is written with. */
  written: ReadonlySet<string>,
): Promise<{
  left: Map<string, Set<string>>;
  later: Array<{ rowId: string; column: string; targetId: string }>;
  back: Array<{ rowId: string; key: OwnKey; targetId: string }>;
  refused: number;
}> {
  const coming = new Set(rows.map((row) => row.recordId));
  const left = new Map<string, Set<string>>();
  const later: Array<{ rowId: string; column: string; targetId: string }> = [];
  const back: Array<{ rowId: string; key: OwnKey; targetId: string }> = [];
  let refused = 0;
  const leave = (rowId: string, column: string) => {
    const columns = left.get(rowId) ?? new Set<string>();
    columns.add(column);
    left.set(rowId, columns);
  };
  for (const key of map.ownKeys) {
    if (!written.has(key.column)) continue;
    const wanted = rows.flatMap((row) => {
      const stored = row.snapshot[key.column];
      if (typeof stored === "string") {
        return [{ rowId: row.recordId, target: stored, stored: true }];
      }
      const note = noted
        .get(row.recordId)
        ?.keys.find((item) => item.column === key.column);
      return note
        ? [{ rowId: row.recordId, target: note.target, stored: false }]
        : [];
    });
    const asked = [
      ...new Set(
        wanted
          .filter((item) => !coming.has(item.target))
          .map((item) => item.target),
      ),
    ];
    const open = new Set<string>();
    const closed = new Set<string>();
    if (asked.length > 0) {
      if (key.inverseField === null) {
        const found = await runRows(
          tx,
          buildExistingIds({ table: key.physical, ids: asked }),
        );
        for (const row of found) open.add(String(row.id));
      } else {
        const statuses = await lockedStatuses(tx, key.physical, asked);
        for (const [id, status] of statuses) {
          (status === "locked" || status === "signed" ? closed : open).add(id);
        }
      }
    }
    const notes = new Map<string, KeptLinks>();
    for (const { rowId, target, stored } of wanted) {
      if (coming.has(target) && target !== rowId) {
        if (stored) leave(rowId, key.column);
        later.push({ rowId, column: key.column, targetId: target });
        back.push({ rowId, key, targetId: target });
      } else if (target === rowId || open.has(target)) {
        if (!stored)
          later.push({ rowId, column: key.column, targetId: target });
        back.push({ rowId, key, targetId: target });
      } else {
        if (stored) leave(rowId, key.column);
        if (closed.has(target)) {
          refused += 1;
        } else {
          const note = notes.get(target) ?? {
            junctions: [],
            holders: [{ column: key.columnId, ids: [] }],
            keys: [],
          };
          note.holders[0]?.ids.push(rowId);
          notes.set(target, note);
        }
      }
    }
    await noteForTrashed(tx, who, key.tableId, notes);
  }
  return { left, later, back, refused };
}

/**
 * Puts a restored row back into the rows linked to it. A holder takes its
 * key again only while the key is still empty: one set since is a newer
 * choice. A row locked or signed since is left as it is, and counted. A row
 * still in the trash gets a note, and the link comes back with it.
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
    const present = new Set(rows.map((row) => String(row.id)));
    await noteForTrashed(
      tx,
      who,
      holder.tableId,
      new Map(
        saved.ids
          .filter((id) => !present.has(id))
          .map((id) => [
            id,
            {
              junctions: [],
              holders: [],
              keys: [{ column: holder.column, target: rowId }],
            },
          ]),
      ),
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
    let present: Set<string>;
    if (junction.otherField === null) {
      const found = await runRows(
        tx,
        buildExistingIds({ table: junction.other, ids: saved.ids }),
      );
      alive = found.map((row) => String(row.id));
      present = new Set(alive);
    } else {
      const statuses = await lockedStatuses(tx, junction.other, saved.ids);
      present = new Set(statuses.keys());
      alive = [];
      for (const [id, status] of statuses) {
        if (id !== rowId && (status === "locked" || status === "signed")) {
          refused += 1;
        } else {
          alive.push(id);
        }
      }
    }
    const theirs: Side = saved.side === "left_id" ? "right_id" : "left_id";
    await noteForTrashed(
      tx,
      who,
      junction.otherTableId,
      new Map(
        saved.ids
          .filter((id) => !present.has(id))
          .map((id) => [
            id,
            {
              junctions: [
                { junction: saved.junction, side: theirs, ids: [rowId] },
              ],
              holders: [],
              keys: [],
            },
          ]),
      ),
    );
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
