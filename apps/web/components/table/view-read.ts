import type { FilterGroup } from "@anygriddb/core";
import type { CatalogColumn, ViewConfig } from "../../lib/types";
import { isEditableColumn } from "../grid/grid-clipboard";
import type { Groups, RowsLayout, RowsQuery } from "../grid/use-rows";
import type { CellValue } from "./table-context";
import type { ViewPatch } from "./view-toolbar";

/**
 * What a read of a view's rows asks the server. Settings kept locally
 * (not stored yet, or a person's own on a view they may not change) go
 * with the read, and the view's stored filter is set aside: the server
 * ANDs a filter it is given with the view's own. `scope` is what the kind
 * of view adds: the weeks a calendar shows, the rows a map can place.
 */
export function rowsQuery(input: {
  viewId: string | undefined;
  search: string;
  config: ViewConfig;
  local: ViewPatch;
  scope: FilterGroup | undefined;
}): RowsQuery {
  const { config, local, scope } = input;
  const kept =
    local.filter !== undefined ||
    local.sort !== undefined ||
    local.groupBy !== undefined ||
    local.filtersDisabled !== undefined;
  const own = config.filtersDisabled ? undefined : config.filter;
  const filter = kept
    ? own && scope
      ? { conjunction: "and" as const, conditions: [own, scope] }
      : (own ?? scope)
    : scope;
  return {
    viewId: input.viewId,
    search: input.search || undefined,
    ...(kept
      ? {
          ignoreViewFilter: true,
          sort: config.sort,
          groupBy: config.groupBy,
        }
      : {}),
    ...(filter ? { filter } : {}),
  };
}

/**
 * The field a kanban stacks its cards by: the one its view names, or the
 * table's first list of options. Nothing for another kind of view.
 */
export function kanbanStack(
  viewType: string,
  config: ViewConfig,
  columns: readonly CatalogColumn[],
): string | undefined {
  if (viewType !== "kanban") return undefined;
  return typeof config.stackColumn === "string"
    ? config.stackColumn
    : columns.find((column) => column.fieldType === "single_select")?.name;
}

/**
 * How a view reads its rows: a grid page after page, or with where each
 * group starts once it groups; a kanban stack by stack; a gallery and a
 * timeline page after page; any other view in one page.
 */
export function rowsLayout(input: {
  viewType: string;
  grouped: boolean;
  stacked: boolean;
}): RowsLayout {
  if (input.viewType === "grid") return input.grouped ? "grouped" : "pages";
  if (input.stacked) return "stacks";
  return input.viewType === "gallery" || input.viewType === "timeline"
    ? "pages"
    : "onePage";
}

/** How many rows each day holds, from a read grouped by the day's field. */
export function countsByDay(groups: Groups): Map<string, number> {
  return new Map(
    groups
      .filter((group) => group.depth === 1)
      .map((group) => [
        typeof group.keys[0] === "string" ? group.keys[0] : "",
        group.count,
      ]),
  );
}

/** Values a new row takes so it stays visible in a filtered view. */
export function prefillFromFilter(
  filter: FilterGroup | undefined,
  columns: readonly CatalogColumn[],
): Record<string, CellValue> {
  if (!filter || filter.conjunction !== "and") return {};
  const values: Record<string, CellValue> = {};
  for (const node of filter.conditions) {
    if ("conjunction" in node) continue;
    const column = columns.find((item) => item.name === node.column);
    if (!column || !isEditableColumn(column)) continue;
    if (
      node.op === "is" &&
      (typeof node.value === "string" ||
        typeof node.value === "number" ||
        typeof node.value === "boolean")
    ) {
      values[column.name] = node.value;
    }
    if (
      node.op === "has_any_of" &&
      Array.isArray(node.value) &&
      column.fieldType === "multi_select"
    ) {
      values[column.name] = node.value.slice(0, 1);
    }
  }
  return values;
}
