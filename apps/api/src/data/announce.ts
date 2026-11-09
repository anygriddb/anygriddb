import type { Database } from "@anygriddb/db";
import type { Bus } from "../realtime/bus.js";
import {
  publishRows,
  publishStale,
  type RowsOp,
} from "../realtime/channels.js";
import { liveColumn } from "./live.js";

export type AnnounceDeps = {
  db: Database;
  bus: Bus;
  log: (error: unknown, message: string) => void;
};

/** Tables whose links read `tableId`, so their lookups may have moved. */
export async function dependentTables(
  db: Database,
  tableId: string,
): Promise<string[]> {
  const incoming = await db
    .selectFrom("relations as r")
    .innerJoin("dataColumns as c", "c.id", "r.fromColumnId")
    .select("c.tableId")
    .where("r.toTableId", "=", tableId)
    .where(liveColumn("c"))
    .execute();
  return [
    ...new Set(
      incoming.map((row) => row.tableId).filter((id) => id !== tableId),
    ),
  ];
}

/**
 * Tells open tabs which rows changed and marks dependent tables stale. It
 * runs after the write committed. Webhooks, automations, and notifications
 * do not depend on it: their events were queued inside the write's
 * transaction (ADR 0008).
 */
export async function announceRows(
  deps: AnnounceDeps,
  tableId: string,
  op: RowsOp,
  rowIds: readonly string[],
  extraTables: readonly string[] = [],
): Promise<void> {
  const log = (error: unknown) => deps.log(error, "realtime publish failed");
  await publishRows(deps.bus, tableId, op, rowIds, log);
  await publishStale(
    deps.bus,
    [...(await dependentTables(deps.db, tableId)), ...extraTables],
    log,
  );
}
