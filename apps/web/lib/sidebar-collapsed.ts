/**
 * Which bases and folders the person folded shut in the sidebar. Kept in
 * this browser only, like the sidebar's width.
 */
const STORAGE_KEY = "ag_sidebar_collapsed";

/** Reads a stored JSON payload into a set of ids. */
export function parseSidebarCollapsed(raw: string | null): Set<string> {
  if (!raw) return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(
      parsed.filter((item): item is string => typeof item === "string"),
    );
  } catch {
    return new Set();
  }
}

export function readSidebarCollapsed(): Set<string> {
  try {
    return parseSidebarCollapsed(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return new Set();
  }
}

export function writeSidebarCollapsed(ids: ReadonlySet<string>): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // Storage can be blocked; the fold still applies to this page.
  }
}

type FoldableBase = { id: string; folders: readonly { id: string }[] };

/**
 * Collapse all shuts every base. Expand all opens them. A folder stays
 * as the person left it: shutting a base already hides its folders, and
 * opening the base must not decide them again.
 */
export function toggleSidebarFold(
  current: ReadonlySet<string>,
  bases: readonly FoldableBase[],
): Set<string> {
  const next = new Set(current);
  if (bases.length === 0) return next;
  const allShut = bases.every((base) => current.has(base.id));
  for (const base of bases) {
    if (allShut) next.delete(base.id);
    else next.add(base.id);
  }
  return next;
}
