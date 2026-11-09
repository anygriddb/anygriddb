import type { CatalogBase, CatalogTable } from "./types";

export type ShortcutIds = {
  pinnedBases: readonly string[];
  pinnedTables: readonly string[];
  recentTables: ReadonlyArray<{ tableId: string; openedAt: string }>;
};

export type ResolvedShortcuts = {
  pinned: Array<
    | { kind: "base"; base: CatalogBase }
    | { kind: "table"; base: CatalogBase; table: CatalogTable }
  >;
  recent: Array<{ base: CatalogBase; table: CatalogTable; openedAt: string }>;
};

/**
 * Shortcuts the person can still open: the catalog lists only what they
 * read and what is out of the trash, so a pin or a recent table outside
 * it is left out.
 */
export function resolveShortcuts(
  bases: readonly CatalogBase[],
  ids: ShortcutIds | undefined,
): ResolvedShortcuts {
  const tables = new Map<string, { base: CatalogBase; table: CatalogTable }>();
  for (const base of bases) {
    for (const table of base.tables) tables.set(table.id, { base, table });
  }
  const pinned: ResolvedShortcuts["pinned"] = [];
  for (const id of ids?.pinnedBases ?? []) {
    const base = bases.find((item) => item.id === id);
    if (base) pinned.push({ kind: "base", base });
  }
  for (const id of ids?.pinnedTables ?? []) {
    const found = tables.get(id);
    if (found) pinned.push({ kind: "table", ...found });
  }
  const recent = (ids?.recentTables ?? []).flatMap((item) => {
    const found = tables.get(item.tableId);
    return found ? [{ ...found, openedAt: item.openedAt }] : [];
  });
  return { pinned, recent };
}
