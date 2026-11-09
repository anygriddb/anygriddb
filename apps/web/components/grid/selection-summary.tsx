import { useLingui } from "@lingui/react/macro";
import { formatNumber } from "../../lib/format";
import { useLocale } from "../../lib/i18n";
import type { CatalogColumn, RowItem } from "../../lib/types";
import { type GridSelection, useSelectionState } from "./selection";
import { summarizeSelection } from "./selection-summary-model";

/**
 * The count, sum, mean, minimum, and maximum of the selected cells, over
 * the rows loaded. It reads the selection itself, so moving it re-renders
 * this bar and not the grid.
 */
export function SelectionSummaryBar({
  selection,
  columns,
  rowAt,
}: {
  selection: GridSelection;
  columns: readonly CatalogColumn[];
  rowAt: (position: number) => RowItem | undefined;
}) {
  const { t } = useLingui();
  const { locale } = useLocale();
  useSelectionState(selection);
  const range = selection.getRange();
  if (!range || (range.r1 === range.r2 && range.c1 === range.c2)) return null;
  const cells: Array<{ value: unknown; numeric: boolean }> = [];
  for (let r = range.r1; r <= range.r2; r += 1) {
    const row = rowAt(r);
    if (!row) continue;
    for (let c = range.c1; c <= range.c2; c += 1) {
      const column = columns[c];
      if (!column) continue;
      cells.push({
        value: row[column.name as keyof RowItem],
        numeric: column.kind === "number",
      });
    }
  }
  const summary = summarizeSelection(cells);
  // One column keeps its number format: currency, percent, decimals.
  const format =
    range.c1 === range.c2 ? columns[range.c1]?.config.number : undefined;
  const show = (value: string | number) => formatNumber(value, locale, format);
  const parts = [
    t`Filled: ${{ filled: summary.filled }} of ${{ cells: summary.cells }}`,
  ];
  if (summary.sum !== undefined && summary.numbers > 0) {
    parts.push(
      t`Sum: ${{ sum: show(summary.sum) }}`,
      t`Mean: ${{ mean: show(summary.mean ?? 0) }}`,
      t`Min: ${{ min: show(summary.min ?? "0") }}`,
      t`Max: ${{ max: show(summary.max ?? "0") }}`,
    );
  }
  return (
    <div
      className="pointer-events-none absolute bottom-10 left-1/2 z-20 -translate-x-1/2 rounded-md border border-border bg-card/95 px-3 py-1 text-xs text-muted-foreground tabular-nums shadow"
      role="status"
      aria-label={t`Selection statistics`}
    >
      {parts.join(" · ")}
    </div>
  );
}
