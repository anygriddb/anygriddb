import { MAX_VIEW_GROUPS, MAX_VIEW_SORTS } from "@anygriddb/core";
import type { CatalogColumn, ViewConfig } from "../../lib/types";
import { nextFrozenColumns } from "../grid/margin-column";
import { DEFAULT_FROZEN } from "./column-layout";
import { newCondition } from "./filter-builder";
import { upsertFirstLevel } from "./view-levels";
import type { ViewPatch } from "./view-toolbar";

/**
 * The change an entry of a field's menu makes to the view: sorted or
 * grouped by the field first, the field hidden, the columns frozen up to
 * it (or freed, from the last frozen one), a condition on it added to the
 * filter. Nothing for an entry that changes the table instead.
 */
export function fieldMenuPatch(
  action: string,
  column: CatalogColumn,
  view: { config: ViewConfig; visible: readonly CatalogColumn[] },
): ViewPatch | undefined {
  const { config } = view;
  switch (action) {
    case "sort-asc":
    case "sort-desc":
      return {
        sort: upsertFirstLevel(
          config.sort ?? [],
          {
            column: column.name,
            direction: action === "sort-asc" ? "asc" : "desc",
          },
          MAX_VIEW_SORTS,
        ),
      };
    case "group":
      return {
        groupBy: upsertFirstLevel(
          config.groupBy ?? [],
          { column: column.name, direction: "asc" },
          MAX_VIEW_GROUPS,
        ),
      };
    case "hide":
      return {
        hiddenFields: [
          ...new Set([...(config.hiddenFields ?? []), column.name]),
        ],
      };
    case "freeze": {
      const index = view.visible.findIndex((item) => item.name === column.name);
      if (index < 0) return undefined;
      return {
        frozenColumns: nextFrozenColumns(
          config.frozenColumns ?? DEFAULT_FROZEN,
          index,
        ),
      };
    }
    case "filter": {
      const current = config.filter ?? {
        conjunction: "and" as const,
        conditions: [],
      };
      return {
        filter: {
          ...current,
          conditions: [...current.conditions, newCondition(column)],
        },
      };
    }
    default:
      return undefined;
  }
}
