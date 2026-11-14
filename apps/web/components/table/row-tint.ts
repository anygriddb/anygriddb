import {
  evaluateFilter,
  type FilterEvalContext,
  type ViewConfig,
} from "@anygriddb/core";
import type { CatalogColumn, RowItem } from "../../lib/types";
import { optionsOf } from "../fields/cell-value";

type ViewColor = NonNullable<ViewConfig["color"]>;

/** Option colour for a row under the view's colour settings, if any. */
export function resolveRowTint(
  row: RowItem,
  columns: readonly CatalogColumn[],
  color: ViewColor | undefined,
  context: FilterEvalContext,
): string | undefined {
  if (!color || color.mode === "none") return undefined;
  if (color.mode === "select" && color.column) {
    const column = columns.find((item) => item.name === color.column);
    if (!column) return undefined;
    const value = row[column.name as keyof RowItem];
    return optionsOf(column).find((option) =>
      Array.isArray(value) ? value[0] === option.name : value === option.name,
    )?.color;
  }
  if (color.mode === "rules") {
    for (const rule of color.rules ?? []) {
      if (evaluateFilter(rule.filter, row, context) === true) {
        return rule.color;
      }
    }
  }
  return undefined;
}
