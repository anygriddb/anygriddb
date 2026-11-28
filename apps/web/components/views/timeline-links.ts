import { isLinkArray } from "../../lib/format";
import type { CatalogColumn, RowItem } from "../../lib/types";

/** A day, in milliseconds. */
const DAY = 86_400_000;

/**
 * The fields a timeline may draw its rows' dependencies by (ROADMAP 10): a
 * link of the table to itself, to one row or several, read from the side
 * that names the rows a row comes after.
 */
export function dependencyColumns(
  columns: readonly CatalogColumn[],
  tableId: string,
): CatalogColumn[] {
  return columns.filter(
    (column) =>
      (column.fieldType === "relation_one_to_many" ||
        column.fieldType === "relation_many_to_many") &&
      column.relation?.targetTableId === tableId &&
      column.relation.direction !== "inverse",
  );
}

/**
 * The link a timeline draws dependencies by: only the one its view chose,
 * never one by default, since a link to the same table may say anything
 * else of two rows.
 */
export function dependencyColumn(
  config: Record<string, unknown>,
  candidates: readonly CatalogColumn[],
): string | undefined {
  return candidates.find((column) => column.name === config.dependencyColumn)
    ?.name;
}

/** The rows a row comes after, as its link names them. */
export function predecessorsOf(
  row: RowItem,
  column: string | undefined,
): Array<{ id: string; label: string }> {
  if (!column) return [];
  const value = row[column as keyof RowItem];
  return isLinkArray(value) ? value : [];
}

/** Where a row's bar lies: its first day, and the day after its last. */
export type BarSpan = { from: number; until: number };

/** A stored date or date and time, as the timeline places it. */
export function toTime(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const time = Date.parse(value.length === 10 ? `${value}T00:00:00Z` : value);
  return Number.isFinite(time) ? time : null;
}

/** A row's bar, as the timeline draws it; none without a start. */
export function barSpan(
  row: RowItem,
  startName: string,
  endName: string | undefined,
): BarSpan | null {
  const from = toTime(row[startName as keyof RowItem]);
  if (from === null) return null;
  const end = endName ? (toTime(row[endName as keyof RowItem]) ?? from) : from;
  return { from, until: Math.max(end, from) + DAY };
}

/** Whether a row starts before a row it comes after has ended. */
export function startsEarly(row: BarSpan, after: BarSpan): boolean {
  return row.from < after.until;
}

/** A line of the timeline as the arrows read it. */
export type ArrowLine = {
  rowId: string;
  /** The line's middle, in the axis's pixels. */
  middle: number;
  span: BarSpan | null;
  /** The rows it comes after. */
  after: readonly string[];
};

/** An arrow from the end of a row's bar to the start of a row after it. */
export type Arrow = {
  key: string;
  from: { x: number; y: number };
  to: { x: number; y: number };
  /** The later row starts before the earlier one ends. */
  early: boolean;
};

/**
 * The arrows between the lines on screen: from each bar a row comes after
 * to that row's bar, each end held to the period shown. A row whose
 * earlier row is not on screen, or has no bar, draws no arrow for it.
 */
export function arrowsBetween(input: {
  lines: readonly ArrowLine[];
  min: number;
  max: number;
  perDay: number;
}): Arrow[] {
  const x = (time: number) =>
    ((Math.min(Math.max(time, input.min), input.max) - input.min) / DAY) *
    input.perDay;
  const byRow = new Map(input.lines.map((line) => [line.rowId, line]));
  return input.lines.flatMap((line) => {
    const span = line.span;
    if (!span) return [];
    return line.after.flatMap((id) => {
      const earlier = byRow.get(id);
      if (!earlier?.span || earlier.rowId === line.rowId) return [];
      return [
        {
          key: `${id}>${line.rowId}`,
          from: { x: x(earlier.span.until), y: earlier.middle },
          to: { x: x(span.from), y: line.middle },
          early: startsEarly(span, earlier.span),
        },
      ];
    });
  });
}

/**
 * An arrow's path: out of the earlier bar's end, down or up to the later
 * row's line, and into its bar's start, with square corners.
 */
export function arrowPath(arrow: Arrow, gap = 6): string {
  const out = arrow.from.x + gap;
  const into = arrow.to.x - gap;
  if (into >= out) {
    return `M ${arrow.from.x} ${arrow.from.y} H ${out} V ${arrow.to.y} H ${arrow.to.x}`;
  }
  // The later bar starts before the earlier ends: around, between lines.
  const between = (arrow.from.y + arrow.to.y) / 2;
  return `M ${arrow.from.x} ${arrow.from.y} H ${out} V ${between} H ${into} V ${arrow.to.y} H ${arrow.to.x}`;
}

/** An arrow's head: a small triangle pointing into the later bar's start. */
export function arrowHead(arrow: Arrow, size = 5): string {
  const { x, y } = arrow.to;
  return `M ${x} ${y} L ${x - size} ${y - size * 0.7} L ${x - size} ${y + size * 0.7} Z`;
}
