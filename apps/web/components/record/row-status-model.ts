import { canWrite } from "../../lib/types";

/** A row as these rules read it: its status column, when it has one. */
type WithStatus = Readonly<Record<string, unknown>>;

/**
 * Whether a row's panel shows its status band: once its review has begun
 * (submitted, locked, signed). Every row starts as a draft, which says
 * nothing; a client's row without a key has no status at all.
 */
export function statusShown(row: WithStatus): boolean {
  return typeof row.ag_status === "string" && row.ag_status !== "draft";
}

/** Whether the row's panel offers to submit it, from its menu. */
export function canSubmitRow(
  row: WithStatus,
  role: Parameters<typeof canWrite>[0],
): boolean {
  return row.ag_status === "draft" && canWrite(role);
}
