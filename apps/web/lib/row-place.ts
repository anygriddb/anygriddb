/**
 * Where a row goes when someone moves it by hand (ADR 0060). The server
 * places it just before or just after another row; these say which.
 */
import type { RowPlace } from "@anygriddb/core";

export type { RowPlace };

/**
 * A row dropped on another of the same list takes that row's slot: after
 * it when it came from above, before it otherwise (from below, or from
 * another list).
 */
export function dropPlace(
  from: number | undefined,
  to: number,
  targetId: string,
): RowPlace {
  return from !== undefined && from < to
    ? { after: targetId }
    : { before: targetId };
}

/**
 * The place between two neighbours: after the row above, or before the
 * row below when it was first. Null when it had neither.
 */
export function placeBetween(
  above: string | undefined,
  below: string | undefined,
): RowPlace | null {
  if (above !== undefined) return { after: above };
  if (below !== undefined) return { before: below };
  return null;
}
