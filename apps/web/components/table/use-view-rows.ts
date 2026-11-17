import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useChannel } from "../../lib/realtime";
import { useTRPC } from "../../lib/trpc";
import type { CatalogColumn, ViewConfig, ViewItem } from "../../lib/types";
import { useRows } from "../grid/use-rows";
import {
  calendarFilter,
  calendarStart,
  thisMonth,
} from "../views/calendar-view";
import { placeColumns, placeFilter } from "../views/map-places";
import {
  timelineFilter,
  timelinePeriod,
  timelineScale,
} from "../views/timeline-period";
import { readKey } from "./view-patch";
import { countsByDay, kanbanStack, rowsLayout, rowsQuery } from "./view-read";
import type { ViewPatch } from "./view-toolbar";

/**
 * The rows a view shows, read as its kind of view needs them: a grid page
 * after page, a calendar the six weeks it shows, a timeline the period it
 * shows, a map the rows that have a place, a kanban stack by stack. A
 * setting changed locally and then stored asks for the same rows: they
 * are not read again, and the view keeps its place.
 */
export function useViewRows(input: {
  baseId: string;
  tableId: string;
  view: ViewItem | undefined;
  config: ViewConfig;
  /** The settings not stored yet (`useViewSettings`). */
  local: ViewPatch;
  search: string;
  /** The table's fields, in the view's order. */
  columns: readonly CatalogColumn[];
}) {
  const { baseId, tableId, view, config, local, search, columns } = input;
  const api = useTRPC();
  const viewType = view?.viewType ?? "grid";
  const grouped = viewType === "grid" && (config.groupBy?.length ?? 0) > 0;

  // A calendar reads the rows of the six weeks it shows, not a first page.
  const [calendarMonth, setCalendarMonth] = useState(thisMonth);
  const calendarField =
    viewType === "calendar" ? calendarStart(columns, config) : undefined;
  // A timeline reads the rows whose bars cross the period it shows.
  const [timelineFocus, setTimelineFocus] = useState(thisMonth);
  const timelineStart =
    viewType === "timeline" ? calendarStart(columns, config)?.name : undefined;
  const timelineEnd =
    timelineStart && typeof config.endColumn === "string"
      ? columns.find((column) => column.name === config.endColumn)?.name
      : undefined;
  const timelineAt = timelineScale(config.timelineScale);
  // A map reads only the rows that have a place.
  const mapPlaces =
    viewType === "map" ? placeColumns(config, columns) : undefined;
  const place = mapPlaces?.place;
  const latitude = mapPlaces?.latitude;
  const longitude = mapPlaces?.longitude;
  const scope = useMemo(
    () =>
      calendarField
        ? calendarFilter(calendarField, calendarMonth)
        : timelineStart
          ? timelineFilter(
              timelineStart,
              timelineEnd,
              timelinePeriod(timelineFocus, timelineAt),
            )
          : placeFilter({ place, latitude, longitude }),
    [
      calendarField,
      calendarMonth,
      timelineStart,
      timelineEnd,
      timelineFocus,
      timelineAt,
      place,
      latitude,
      longitude,
    ],
  );
  const askedQuery = useMemo(
    () => rowsQuery({ viewId: view?.id, search, config, local, scope }),
    [view?.id, search, local, config, scope],
  );
  // A setting is read with its value kept locally, then saved: the rows
  // read then stay, and the view keeps its place, as long as what the
  // read asks for is the same.
  const asked = readKey({
    viewId: view?.id,
    search,
    filter: config.filtersDisabled ? undefined : config.filter,
    sort: config.sort,
    groupBy: config.groupBy,
    scope,
  });
  const [kept, setKept] = useState({ key: asked, query: askedQuery });
  if (kept.key !== asked) setKept({ key: asked, query: askedQuery });
  const query = kept.key === asked ? kept.query : askedQuery;
  // A kanban reads its rows grouped by its stack field: each stack is the
  // rows from where its group starts, read as the stack scrolls.
  const stack = kanbanStack(viewType, config, columns);
  const readQuery = useMemo(
    () =>
      stack
        ? {
            ...query,
            groupBy: [{ column: stack, direction: "asc" as const }],
          }
        : query,
    [query, stack],
  );
  const layout = rowsLayout({ viewType, grouped, stacked: Boolean(stack) });
  const rows = useRows(tableId, readQuery, layout);

  // A calendar shows a page of rows; its days count every row, as the
  // database groups them.
  const dayField =
    calendarField?.kind === "date" ? calendarField.name : undefined;
  const dayCounts = useQuery({
    ...api.rows.read.queryOptions({
      ...query,
      tableId,
      offset: 0,
      limit: 1,
      withTotal: false,
      groupBy: [{ column: dayField ?? "", direction: "asc" }],
    }),
    enabled: dayField !== undefined,
  });
  const counts = useMemo(
    () =>
      dayField && dayCounts.data
        ? countsByDay(dayCounts.data.groups)
        : undefined,
    [dayField, dayCounts.data],
  );

  // A field added, changed, or removed changes what the rows hold: a new
  // formula's values, a converted field's. Read them again.
  useChannel(baseId, {
    message: (message) => {
      if (message.type === "catalog") rows.refresh();
    },
    resync: () => {
      rows.refresh();
    },
  });

  return {
    rows,
    layout,
    counts,
    calendarMonth,
    setCalendarMonth,
    timelineFocus,
    setTimelineFocus,
  };
}
