import type { RowEvent } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { sql } from "kysely";
import { isLinkMarker } from "../data/rows.js";

/** Audit actions on rows, and the webhook event each one is. */
const EVENT_OF = {
  insert: "insert",
  update: "update",
  delete: "delete",
  submit: "status",
  lock: "status",
  unlock: "status",
  sign: "status",
} as const satisfies Record<string, RowEvent["event"]>;

type AuditAction = keyof typeof EVENT_OF;

type AuditEntry = {
  id: string;
  occurred_at: Date | string;
  user_id: string;
  action: AuditAction;
  table_id: string;
  record_id: string;
  old_value: Record<string, unknown> | null;
  new_value: Record<string, unknown> | null;
  source: string | null;
};

/** Bookkeeping columns that change with every write. */
function isBookkeeping(name: string): boolean {
  return name.startsWith("ag_") && name !== "ag_status";
}

/** Fields whose value differs between two versions of a row. */
export function changedColumns(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): string[] {
  const names = new Set([
    ...Object.keys(before ?? {}),
    ...Object.keys(after ?? {}),
  ]);
  return [...names].filter(
    (name) =>
      name !== "id" &&
      !isBookkeeping(name) &&
      JSON.stringify(before?.[name] ?? null) !==
        JSON.stringify(after?.[name] ?? null),
  );
}

export function eventOf(entry: AuditEntry, depth: number): RowEvent {
  const event = EVENT_OF[entry.action];
  const at =
    entry.occurred_at instanceof Date
      ? entry.occurred_at.toISOString()
      : new Date(entry.occurred_at).toISOString();
  return {
    tableId: entry.table_id,
    event,
    rowId: entry.record_id,
    ...(event === "update" || event === "status"
      ? {
          columns: changedColumns(entry.old_value, entry.new_value).slice(
            0,
            500,
          ),
        }
      : {}),
    actorId: entry.user_id,
    ...(entry.source ? { source: entry.source.slice(0, 100) } : {}),
    ...(depth > 0 ? { depth } : {}),
    at,
    auditId: entry.id,
  };
}

/** The row events of one committed transaction, in the order they happened. */
export async function transactionEvents(
  db: Database,
  xact: string,
  depth: number,
): Promise<RowEvent[]> {
  // Raw SQL, read without the camelCase mapping: the columns keep their names.
  const { rows } = await sql<AuditEntry>`
    select id, occurred_at, user_id, action, table_id, record_id,
      old_value, new_value, source
    from audit_events
    where xact_id = ${xact}::xid8
      and table_id is not null
      and record_id is not null
      and action::text in (${sql.join(
        Object.keys(EVENT_OF).map((action) => sql`${action}`),
        sql`, `,
      )})
    order by occurred_at, id
  `.execute(db.withoutPlugins());
  // A delete keeps its many-to-many links in an internal entry: not an event.
  return [...rows]
    .filter((row) => !isLinkMarker(row.old_value))
    .map((row) => eventOf(row, depth));
}
