import { cellText } from "@anygriddb/core";
import type { RowItem } from "../../lib/types";
import type { Groups } from "./use-rows";

/** What the grid draws, one line each. */
export type GridItem =
  | { type: "row"; index: number }
  | {
      type: "group";
      /** The group's values from the top level down: what folding keeps. */
      key: string;
      label: string;
      count: number;
      depth: number;
      color?: string;
    }
  /** The view has more groups than a read counts: the rest are left out. */
  | { type: "limit" }
  | { type: "add" };

/** A level of the grouping: the field it reads, and a value's colour. */
export type GroupLevel = {
  column: string;
  colorOf?: (label: string) => string | undefined;
};

const SEPARATOR = "\u0000";

/** A group value as its header shows it; empty for no value. */
export function groupKeyOf(value: unknown): string {
  if (
    value === null ||
    value === undefined ||
    (Array.isArray(value) && value.length === 0)
  )
    return "";
  if (Array.isArray(value)) {
    return value
      .map((item) =>
        item && typeof item === "object" && "label" in item
          ? String((item as { label: unknown }).label)
          : String(item),
      )
      .join(", ");
  }
  return cellText(value);
}

function pathOf(labels: readonly string[]): string {
  return labels.join(SEPARATOR);
}

/** True when the read said where every one of its groups starts. */
export function hasStarts(groups: Groups): boolean {
  return (
    groups.length > 0 && groups.every((group) => group.start !== undefined)
  );
}

/**
 * A grouped grid laid out from where the database says each group starts:
 * every row of the view has its place before it is read. A folded group
 * keeps its header and skips its rows. A read counts `maxGroups` groups at
 * most: when it stopped there, the rows from the last group it named on
 * are left out, and a `limit` line says so.
 */
export function layoutFromStarts(
  groups: Groups,
  levels: readonly GroupLevel[],
  collapsed: ReadonlySet<string>,
  maxGroups: number,
): GridItem[] {
  const ordered = groups.toSorted(
    (left, right) =>
      (left.start ?? 0) - (right.start ?? 0) || left.depth - right.depth,
  );
  const truncated = ordered.length >= maxGroups;
  const cut = truncated
    ? (ordered.at(-1)?.start ?? 0)
    : Number.POSITIVE_INFINITY;
  const items: GridItem[] = [];
  // Rows before this place belong to a folded group.
  let hiddenUntil = 0;
  for (const group of ordered) {
    const start = group.start ?? 0;
    if (start >= cut) break;
    const depth = group.depth - 1;
    const level = levels[depth];
    if (!level || start < hiddenUntil) continue;
    const labels = group.keys.slice(0, depth + 1).map(groupKeyOf);
    const label = labels[depth] ?? "";
    const key = pathOf(labels);
    const color = level.colorOf?.(label);
    items.push({
      type: "group",
      key,
      label,
      count: group.count,
      depth,
      ...(color ? { color } : {}),
    });
    if (collapsed.has(key)) {
      hiddenUntil = start + group.count;
    } else if (depth === levels.length - 1) {
      const end = Math.min(start + group.count, cut);
      for (let index = start; index < end; index += 1) {
        items.push({ type: "row", index });
      }
    }
  }
  if (truncated) items.push({ type: "limit" });
  return items;
}

/**
 * A grouped grid laid out from the rows read so far, in order: a header
 * wherever a value changes. For a read that could not say where its groups
 * start; a header counts the rows of its group as the read counted them,
 * or those read so far when its values cannot be matched.
 */
export function layoutFromRows(
  rows: readonly RowItem[],
  levels: readonly GroupLevel[],
  collapsed: ReadonlySet<string>,
  groups: Groups,
): GridItem[] {
  const counted = new Map(
    groups.map((group) => [
      pathOf(group.keys.slice(0, group.depth).map(groupKeyOf)),
      group.count,
    ]),
  );
  const keysOf = (row: RowItem) =>
    levels.map((level) => groupKeyOf(row[level.column as keyof RowItem]));
  const seen = new Map<string, number>();
  for (const row of rows) {
    const keys = keysOf(row);
    keys.forEach((_, depth) => {
      const path = pathOf(keys.slice(0, depth + 1));
      seen.set(path, (seen.get(path) ?? 0) + 1);
    });
  }
  const items: GridItem[] = [];
  let previous: string[] = [];
  rows.forEach((row, index) => {
    const keys = keysOf(row);
    let hidden = false;
    for (let depth = 0; depth < keys.length; depth += 1) {
      const path = pathOf(keys.slice(0, depth + 1));
      const changed = path !== pathOf(previous.slice(0, depth + 1));
      if (changed && !hidden) {
        const label = keys[depth] ?? "";
        const color = levels[depth]?.colorOf?.(label);
        items.push({
          type: "group",
          key: path,
          label,
          count: counted.get(path) ?? seen.get(path) ?? 0,
          depth,
          ...(color ? { color } : {}),
        });
      }
      if (collapsed.has(path)) hidden = true;
    }
    previous = keys;
    if (!hidden) items.push({ type: "row", index });
  });
  return items;
}

/**
 * Where row `index` stands among the rows shown, or -1: `shown` holds row
 * indexes in increasing order, the rows of folded groups left out.
 */
export function positionOf(shown: readonly number[], index: number): number {
  let low = 0;
  let high = shown.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const value = shown[middle] ?? 0;
    if (value === index) return middle;
    if (value < index) low = middle + 1;
    else high = middle - 1;
  }
  return -1;
}
