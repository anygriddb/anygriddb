/**
 * A base's activity, read by its members: who changed what,
 * and when, in the tables, fields, and rows each member may see. A table
 * where a row rule keeps some rows from them is left out, as the home
 * page leaves out its last change: its events could tell of those rows.
 * A field they may not see is left out of an edit, and an edit of such
 * fields alone is not told. Field names only: values stay in each row's
 * history, behind its rights.
 */
import {
  type ActivityEvent,
  type ActivityKind,
  type Binding,
  cellText,
  effectiveTableRole,
  type EngineAccess,
  roleAllows,
} from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { sql } from "kysely";
import { readerAccess, readerEngine } from "./acl.js";
import { changedKeys } from "./audit-keys.js";
import { loadCatalogRows, type CatalogRows } from "./engine.js";
import { liveTable } from "./live.js";
import { readPage } from "./rows.js";

type Reader = { userId: string; bindings: readonly Binding[] };

const ROW_KINDS: Readonly<Record<string, ActivityKind>> = {
  insert: "row_added",
  update: "row_changed",
  delete: "row_deleted",
  submit: "row_submitted",
  lock: "row_locked",
  unlock: "row_unlocked",
  sign: "row_signed",
};

const ACTIONS = [...Object.keys(ROW_KINDS), "catalog"];

/** A trail event as the page reads it, its instant to the microsecond. */
type TrailEvent = {
  id: string;
  at: string;
  userId: string;
  userName: string | null;
  action: string;
  tableId: string;
  recordId: string | null;
  oldValue: unknown;
  newValue: unknown;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** Where a page ends, and the next begins. */
function cursorOf(event: TrailEvent): string {
  return `${event.at}_${event.id}`;
}

type Described = Omit<ActivityEvent, "row">;

/**
 * What one trail event tells the reader, or nothing: a row's edit by the
 * fields they see, a field or a table's change by its name.
 */
function describe(
  event: TrailEvent,
  catalog: CatalogRows,
  access: EngineAccess | undefined,
): Described | null {
  const table = catalog.tables.find((item) => item.id === event.tableId);
  if (!table) return null;
  const base = {
    id: event.id,
    at: new Date(event.at).toISOString(),
    by: { id: event.userId, name: event.userName ?? "" },
    tableId: table.id,
    table: table.name,
    rowId: null,
    fields: [],
    field: null,
    before: null,
  };
  const hidden = (name: string) => access?.hidden(table.id, name) ?? false;
  const rowKind = ROW_KINDS[event.action];
  if (rowKind) {
    const own = new Map(
      catalog.columns
        .filter((column) => column.tableId === table.id)
        .map((column) => [column.name, column.label]),
    );
    if (rowKind !== "row_changed") {
      return { ...base, kind: rowKind, rowId: event.recordId };
    }
    const keys = changedKeys(event.oldValue, event.newValue);
    const fields = keys.flatMap((key) => {
      const label = own.get(key);
      return label !== undefined && !hidden(key) ? [label] : [];
    });
    if (fields.length > 0) {
      return { ...base, kind: "row_changed", rowId: event.recordId, fields };
    }
    // Moved by hand (ADR 0060): its place changed, and nothing else seen.
    return keys.includes("ag_position")
      ? { ...base, kind: "row_moved", rowId: event.recordId }
      : null;
  }
  const before = record(event.oldValue);
  const after = record(event.newValue);
  const item = after ?? before;
  if (!item) return null;
  if ("field_type" in item) {
    const name = text(item.name);
    if (!name || hidden(name)) return null;
    const label = text(after?.label) ?? text(before?.label) ?? name;
    if (!before || (before.deleted_at && after && !after.deleted_at)) {
      return { ...base, kind: "field_added", field: label };
    }
    if (!after || (after.deleted_at && !before.deleted_at)) {
      return { ...base, kind: "field_deleted", field: label };
    }
    // A field moved among the others changed nothing of itself.
    const keys = changedKeys(before, after).filter((key) => key !== "position");
    if (keys.length === 0) return null;
    const previous = text(before.label);
    return {
      ...base,
      kind: "field_changed",
      field: label,
      before: previous !== label ? previous : null,
    };
  }
  if ("physical_name" in item && "base_id" in item) {
    if (!before) return after ? { ...base, kind: "table_added" } : null;
    const previous = text(before.name);
    return after && previous && previous !== text(after.name)
      ? { ...base, kind: "table_renamed", before: previous }
      : null;
  }
  return null;
}

/**
 * A page of the base's activity for the reader, newest first: up to
 * `limit` events, read from the trail at most three times that many, each
 * table's newest by its own index. `next` names the event to go on from.
 */
export async function baseActivity(
  db: Database,
  reader: Reader,
  input: { baseId: string; before?: string; limit: number },
): Promise<{ events: ActivityEvent[]; next: string | null }> {
  const ids = (
    await db
      .selectFrom("dataTables")
      .select("id")
      .where("baseId", "=", input.baseId)
      .where("storage", "=", "native")
      .where(liveTable())
      .execute()
  ).map((row) => row.id);
  const catalog = await loadCatalogRows(db, ids);
  const readable = catalog.tables.filter((table) =>
    roleAllows(
      effectiveTableRole(reader.bindings, table.id, table.baseId),
      "read",
    ),
  );
  const access = await readerAccess(db, reader, readable);
  const tables = readable.filter((table) => !access?.rowFilter(table.id));
  if (tables.length === 0) return { events: [], next: null };

  const scan = input.limit * 3;
  const [beforeAt, beforeId] = input.before?.split("_") ?? [];
  const after =
    beforeAt && beforeId
      ? sql`and (a.occurred_at, a.id) < (${beforeAt}::timestamptz, ${beforeId}::uuid)`
      : sql``;
  // The page's events by id and instant first, each table's newest read
  // by its own index; then their payloads, for those events only.
  const { rows } = await sql<TrailEvent>`
    with page as (
      select e.id, e.occurred_at
      from unnest(${tables.map((table) => table.id)}::uuid[]) as t(id)
      cross join lateral (
        select a.id, a.occurred_at
        from audit_events a
        where a.table_id = t.id
          and a.action::text = any(${ACTIONS}::text[])
          ${after}
          -- A table's fields made with it are told by its creation: a
          -- table's own row is the one that names its base.
          and not (
            a.action = 'catalog' and a.old_value is null
            and a.new_value ? 'field_type'
            and exists (
              select 1 from audit_events m
              where m.table_id = a.table_id
                and m.occurred_at = a.occurred_at
                and m.action = 'catalog' and m.old_value is null
                and m.new_value ? 'base_id'
            )
          )
        order by a.occurred_at desc, a.id desc
        limit ${scan}
      ) e
      order by e.occurred_at desc, e.id desc
      limit ${scan}
    )
    select a.id,
      to_char(a.occurred_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at,
      a.user_id as "userId", u.display_name as "userName",
      a.action::text as action, a.table_id as "tableId",
      a.record_id as "recordId", a.old_value as "oldValue",
      a.new_value as "newValue"
    from page p
    join audit_events a on a.id = p.id
    left join users u on u.id = a.user_id
    order by p.occurred_at desc, p.id desc
  `.execute(db);

  const described: Described[] = [];
  let last: TrailEvent | undefined;
  for (const row of rows) {
    last = row;
    const event = describe(row, catalog, access);
    if (event) described.push(event);
    if (described.length === input.limit) break;
  }
  const more = described.length === input.limit || rows.length === scan;
  return {
    events: await withRowNames(db, reader, described),
    next: more && last ? cursorOf(last) : null,
  };
}

/**
 * Each edited row's primary field, as the reader reads it now: a page of
 * rows a table, through their own field and row rules. A row since
 * deleted, or a primary field they may not see, names nothing.
 */
async function withRowNames(
  db: Database,
  reader: Reader,
  events: readonly Described[],
): Promise<ActivityEvent[]> {
  const byTable = new Map<string, Set<string>>();
  for (const event of events) {
    if (!event.rowId) continue;
    const ids = byTable.get(event.tableId) ?? new Set<string>();
    ids.add(event.rowId);
    byTable.set(event.tableId, ids);
  }
  const names = new Map<string, string>();
  for (const [tableId, ids] of byTable) {
    const { engine } = await readerEngine(db, tableId, reader);
    const primary = engine.table.primaryColumn;
    if (!primary || engine.access?.hidden(tableId, primary)) continue;
    const page = await readPage(
      db,
      engine,
      { rowIds: [...ids], limit: ids.size, fields: [primary] },
      { total: false },
    );
    for (const row of page.rows) {
      const name = cellText(row[primary]).trim();
      if (name) names.set(row.id, name.slice(0, 200));
    }
  }
  return events.map((event) => ({
    ...event,
    row: event.rowId ? (names.get(event.rowId) ?? null) : null,
  }));
}
