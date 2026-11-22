/**
 * Rows deleted before a delete kept the rows pointing to them: the keys it
 * cleared are read back from the trail, and written beside that delete, so
 * that a restore finds them. Run only by the operator's command: it adds
 * to the trail of every table it finds such rows in.
 */
import { buildExistingIds } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { runStatement } from "@anygriddb/db";
import { sql } from "kysely";
import {
  linkMapOf,
  linkMarker,
  markerDelete,
  markerHasHolders,
  type SavedHolders,
} from "./row-links.js";

const PAGE = 500;

export type TrashedLinksReport = {
  /** Tables holding at least one row whose links were found. */
  tables: number;
  /** Rows in the trash whose links were found. */
  rows: number;
  /** Links found. */
  links: number;
  /** Markers written: none on a dry run. */
  written: number;
};

type Deletion = {
  id: string;
  recordId: string;
  userId: string;
  occurredAt: Date;
};

export async function recoverTrashedLinks(
  db: Database,
  options: { dryRun: boolean },
): Promise<TrashedLinksReport> {
  const report: TrashedLinksReport = {
    tables: 0,
    rows: 0,
    links: 0,
    written: 0,
  };
  const targets = await db
    .selectFrom("relations as r")
    .innerJoin("dataColumns as c", "c.id", "r.fromColumnId")
    .innerJoin("dataTables as t", "t.id", "r.toTableId")
    .select(["t.id", "t.physicalName"])
    .distinct()
    .where("r.kind", "=", "one_to_many")
    .where("c.fieldType", "=", "relation_one_to_many")
    .where("t.storage", "=", "native")
    .execute();
  for (const target of targets) {
    const found = await recoverTable(db, target, options);
    if (found.rows > 0) report.tables += 1;
    report.rows += found.rows;
    report.links += found.links;
    report.written += found.written;
  }
  return report;
}

async function recoverTable(
  db: Database,
  table: { id: string; physicalName: string },
  options: { dryRun: boolean },
): Promise<{ rows: number; links: number; written: number }> {
  const totals = { rows: 0, links: 0, written: 0 };
  const map = await linkMapOf(db, table.id);
  if (map.holders.length === 0) return totals;
  const seen = new Set<string>();
  let after: { at: Date; id: string } | undefined;
  for (;;) {
    let query = db
      .selectFrom("auditEvents")
      .select(["id", "recordId", "userId", "occurredAt"])
      .where("tableId", "=", table.id)
      .where("action", "=", "delete");
    if (after) {
      const { at, id } = after;
      query = query.where((eb) =>
        eb.or([
          eb("occurredAt", "<", at),
          eb.and([eb("occurredAt", "=", at), eb("id", "<", id)]),
        ]),
      );
    }
    const page = await query
      .orderBy("occurredAt", "desc")
      .orderBy("id", "desc")
      .limit(PAGE)
      .execute();
    const last = page.at(-1);
    if (!last) return totals;
    after = { at: last.occurredAt, id: last.id };

    // The last delete of each row is the one that holds it.
    const latest: Deletion[] = [];
    for (const event of page) {
      if (!event.recordId || seen.has(event.recordId)) continue;
      seen.add(event.recordId);
      latest.push({ ...event, recordId: event.recordId });
    }
    if (latest.length > 0) {
      const found = await recoverPage(db, table, map, latest, options);
      totals.rows += found.rows;
      totals.links += found.links;
      totals.written += found.written;
    }
    if (page.length < PAGE) return totals;
  }
}

async function recoverPage(
  db: Database,
  table: { id: string; physicalName: string },
  map: Awaited<ReturnType<typeof linkMapOf>>,
  latest: readonly Deletion[],
  options: { dryRun: boolean },
): Promise<{ rows: number; links: number; written: number }> {
  const totals = { rows: 0, links: 0, written: 0 };
  const alive = new Set(
    (
      await runStatement(
        db,
        buildExistingIds({
          table: table.physicalName,
          ids: latest.map((item) => item.recordId),
        }),
      )
    ).map((row) => String(row.id)),
  );
  const trashed = latest.filter((item) => !alive.has(item.recordId));
  if (trashed.length === 0) return totals;
  const done = await alreadyKept(db, table.id, trashed);
  const open = trashed.filter((item) => !done.has(item.id));
  if (open.length === 0) return totals;

  const holders = new Map<string, SavedHolders[]>();
  for (const holder of map.holders) {
    const { rows } = await sql<{ deleteId: string; holder: string }>`
      select d.id as "deleteId", h.record_id as holder
      from audit_events d
      join audit_events h
        on h.table_id = d.table_id
        and h.occurred_at = d.occurred_at
        and h.action = 'update'
        and h.record_id <> d.record_id
      where d.id = any(${open.map((item) => item.id)}::uuid[])
        and h.old_value ->> ${holder.column} = d.record_id::text
        and jsonb_exists(h.new_value, ${holder.column})
        and h.new_value ->> ${holder.column} is null
    `.execute(db.withoutPlugins());
    if (rows.length === 0) continue;
    // A field of that name may be on another table: the row says which.
    const there = new Set(
      (
        await runStatement(
          db,
          buildExistingIds({
            table: holder.physical,
            ids: [...new Set(rows.map((row) => row.holder))],
          }),
        )
      ).map((row) => String(row.id)),
    );
    const byDelete = new Map<string, string[]>();
    for (const row of rows) {
      if (!there.has(row.holder)) continue;
      byDelete.set(row.deleteId, [
        ...(byDelete.get(row.deleteId) ?? []),
        row.holder,
      ]);
    }
    for (const [deleteId, ids] of byDelete) {
      holders.set(deleteId, [
        ...(holders.get(deleteId) ?? []),
        { column: holder.columnId, ids },
      ]);
    }
  }

  for (const item of open) {
    const kept = holders.get(item.id);
    if (!kept) continue;
    totals.rows += 1;
    totals.links += kept.reduce((sum, entry) => sum + entry.ids.length, 0);
    if (options.dryRun) continue;
    await db
      .insertInto("auditEvents")
      .values({
        userId: item.userId,
        action: "update",
        tableId: table.id,
        recordId: item.recordId,
        ...linkMarker({ junctions: [], holders: kept, keys: [] }, item.id),
        source: "operator",
      })
      .execute();
    totals.written += 1;
  }
  return totals;
}

/** The deletes whose holders are already written down. */
async function alreadyKept(
  db: Database,
  tableId: string,
  deletions: readonly Deletion[],
): Promise<Set<string>> {
  const markers = await db
    .selectFrom("auditEvents")
    .select(["recordId", "oldValue", "occurredAt"])
    .where("tableId", "=", tableId)
    .where("action", "=", "update")
    .where(
      "recordId",
      "in",
      deletions.map((item) => item.recordId),
    )
    .where(sql<boolean>`jsonb_exists(old_value, '__ag_fk')`)
    .execute();
  const done = new Set<string>();
  for (const marker of markers) {
    if (!markerHasHolders(marker.oldValue)) continue;
    const named = markerDelete(marker.oldValue);
    for (const item of deletions) {
      if (item.recordId !== marker.recordId) continue;
      if (
        named === item.id ||
        (named === undefined &&
          marker.occurredAt.getTime() === item.occurredAt.getTime())
      ) {
        done.add(item.id);
      }
    }
  }
  return done;
}
