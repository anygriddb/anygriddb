import { isLinkArray } from "../../lib/format";
import type { CatalogColumn, RowItem } from "../../lib/types";

/** A list nests the rows it has read, this many at most, and says so past it. */
export const LIST_CEILING = 5_000;

/**
 * The fields a list can nest its rows by: a link to one row of the same
 * table, which each row holds itself. The other side of such a link, the
 * rows under a row, is the same nesting read backwards, and is left out.
 */
export function parentColumns(
  columns: readonly CatalogColumn[],
  tableId: string,
): CatalogColumn[] {
  return columns.filter(
    (column) =>
      column.fieldType === "relation_one_to_many" &&
      column.relation?.targetTableId === tableId &&
      column.relation.direction === "forward",
  );
}

/** The link a list nests by: the one its view chose, or the table's first. */
export function parentColumn(
  config: Record<string, unknown>,
  parents: readonly CatalogColumn[],
): string | undefined {
  return (
    parents.find((column) => column.name === config.parentColumn)?.name ??
    parents[0]?.name
  );
}

/** A row as a list draws it: how deep, and what it has under it. */
export type ListLine = {
  row: RowItem;
  /** 1 for a row under no other. */
  level: number;
  /** The rows straight under it, among those read. */
  children: number;
  folded: boolean;
};

/**
 * The rows in the order a list draws them: each under the row its link
 * names, in the view's own order among the rows of one parent. A row whose
 * parent is not among the rows read (filtered out, past the ceiling,
 * deleted) is drawn under no other, so that nothing is hidden; so are the
 * rows of a loop, which have no top. What is under a folded row is left
 * out.
 */
export function listLines(
  rows: readonly RowItem[],
  parent: string | undefined,
  folded: ReadonlySet<string>,
): ListLine[] {
  const known = new Set(rows.map((row) => row.id));
  const linked = new Map<string, string>();
  if (parent) {
    for (const row of rows) {
      const value = row[parent as keyof RowItem];
      const id = isLinkArray(value) ? value[0]?.id : undefined;
      if (id !== undefined && id !== row.id && known.has(id)) {
        linked.set(row.id, id);
      }
    }
  }
  // A row that is its own ancestor has no top: it goes under no other.
  const looped = (start: string): boolean => {
    const seen = new Set<string>();
    for (
      let at = linked.get(start);
      at !== undefined && !seen.has(at);
      at = linked.get(at)
    ) {
      if (at === start) return true;
      seen.add(at);
    }
    return false;
  };
  const under = new Map<string | undefined, RowItem[]>();
  for (const row of rows) {
    const above = looped(row.id) ? undefined : linked.get(row.id);
    const siblings = under.get(above);
    if (siblings) siblings.push(row);
    else under.set(above, [row]);
  }
  const lines: ListLine[] = [];
  // Depth first, without recursion: a chain of rows may be thousands deep.
  const pending: Array<{ row: RowItem; level: number }> = (
    under.get(undefined) ?? []
  )
    .map((row) => ({ row, level: 1 }))
    .reverse();
  for (let next = pending.pop(); next; next = pending.pop()) {
    const { row, level } = next;
    const below = under.get(row.id) ?? [];
    const isFolded = folded.has(row.id) && below.length > 0;
    lines.push({ row, level, children: below.length, folded: isFolded });
    if (isFolded) continue;
    for (let index = below.length - 1; index >= 0; index -= 1) {
      const child = below[index];
      if (child) pending.push({ row: child, level: level + 1 });
    }
  }
  return lines;
}
