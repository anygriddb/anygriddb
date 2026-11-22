/**
 * How deep a request's input may nest. Far past any filter, formula or JSON
 * cell a page sends, and far short of what a recursive schema survives.
 */
export const MAX_INPUT_DEPTH = 128;

/** Whether a value nests past `limit`. Walked with a stack, never recursed. */
export function nestsPast(value: unknown, limit = MAX_INPUT_DEPTH): boolean {
  const pending: Array<{ item: unknown; depth: number }> = [
    { item: value, depth: 0 },
  ];
  while (pending.length > 0) {
    const next = pending.pop();
    if (!next || typeof next.item !== "object" || next.item === null) continue;
    if (next.depth >= limit) return true;
    const inner = Array.isArray(next.item)
      ? (next.item as unknown[])
      : Object.values(next.item);
    for (const item of inner) pending.push({ item, depth: next.depth + 1 });
  }
  return false;
}
