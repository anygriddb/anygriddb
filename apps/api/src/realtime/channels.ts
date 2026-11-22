export const CELL_TOKEN = /^[A-Za-z0-9_-]{1,128}$/;
const TOKEN = CELL_TOKEN;

function assertToken(value: string, label: string): void {
  if (!TOKEN.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
}

export function gridChannel(channel: string): string {
  assertToken(channel, "grid channel");
  return `grid:${channel}`;
}

export function cellLockKey(
  channel: string,
  rowId: string,
  column: string,
): string {
  assertToken(channel, "grid channel");
  assertToken(rowId, "row id");
  assertToken(column, "column");
  return `cell:${channel}:${rowId}:${column}`;
}

export type RowsOp = "insert" | "update" | "delete" | "refresh";

/**
 * Says that someone's rights may have changed. It names no one: each
 * process asks again what each of its sockets may hear, in one question.
 * Never a grid channel, which all start with `grid:`.
 */
export const RIGHTS_CHANNEL = "rights";
const RIGHTS_CHANGED = JSON.stringify({ type: "rights" });

type Publisher = {
  publish: (channel: string, message: string) => Promise<unknown>;
};

/**
 * Tells subscribers of a table which rows changed. Clients re-read those
 * rows with their own permissions, so no cell value travels here.
 */
export async function publishRows(
  bus: Publisher,
  tableId: string,
  op: RowsOp,
  rowIds: readonly string[],
  onError: (error: unknown) => void,
): Promise<void> {
  try {
    for (let start = 0; start < Math.max(rowIds.length, 1); start += 150) {
      await bus.publish(
        gridChannel(tableId),
        JSON.stringify({
          type: "rows",
          channel: tableId,
          op,
          rowIds: rowIds.slice(start, start + 150),
        }),
      );
    }
  } catch (error) {
    onError(error);
  }
}

/** After a change of who may read what is committed, on every process. */
export async function publishRightsChanged(
  bus: Publisher,
  onError: (error: unknown) => void,
): Promise<void> {
  try {
    await bus.publish(RIGHTS_CHANNEL, RIGHTS_CHANGED);
  } catch (error) {
    onError(error);
  }
}

/** Tells subscribers that computed values may have moved, e.g. a lookup into a changed table. */
export async function publishStale(
  bus: Publisher,
  tableIds: readonly string[],
  onError: (error: unknown) => void,
): Promise<void> {
  try {
    for (const tableId of new Set(tableIds)) {
      await bus.publish(
        gridChannel(tableId),
        JSON.stringify({ type: "stale", channel: tableId }),
      );
    }
  } catch (error) {
    onError(error);
  }
}

/** Tells everyone looking at a base that its tables or columns changed. */
export async function publishCatalog(
  bus: Publisher,
  baseId: string,
  onError: (error: unknown) => void,
): Promise<void> {
  try {
    await bus.publish(
      gridChannel(baseId),
      JSON.stringify({ type: "catalog", channel: baseId }),
    );
  } catch (error) {
    onError(error);
  }
}
