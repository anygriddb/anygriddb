import { MAX_GROUPS } from "@anygriddb/core";
import { cn } from "@anygriddb/ui";
import { useLingui } from "@lingui/react/macro";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown, ChevronRight, Plus } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatNumber } from "../../lib/format";
import { useLocale } from "../../lib/i18n";
import {
  groupLevels,
  hasStarts,
  readPrefix,
  viewItems,
} from "../grid/group-layout";
import { useTable } from "../table/table-context";
import {
  CardFields,
  cardColumns,
  useRowTitle,
  type ViewProps,
} from "./view-common";

const CARD_ESTIMATE = 96;
const HEADER_ESTIMATE = 36;
const NONE_READ: never[] = [];
const NO_GROUPS: never[] = [];

/**
 * A grid's rows as a list of cards, on a screen too narrow for its columns
 * (a phone): each card names its row by its primary field, shows the
 * view's next fields, and opens the record panel. A grouped view keeps
 * its headers, folded as on the grid, and the last card adds a row.
 */
export function RowCards(
  props: ViewProps & {
    groupBy: ReadonlyArray<{ column: string }>;
    canAdd: boolean;
  },
) {
  const { t } = useLingui();
  const { locale } = useLocale();
  const table = useTable();
  const title = useRowTitle();
  const fields = cardColumns({}, props.columns, []);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const grouped = props.groupBy.length > 0;
  const groups = props.groups ?? NO_GROUPS;
  const placed = grouped && hasStarts(groups);
  // The rows read so far, from the first: what a grouped view lays out
  // when its read did not say where its groups start.
  const { rowAt, rows: loaded } = props;
  const readSoFar = useMemo(
    () =>
      grouped && !placed && loaded.length > 0 ? readPrefix(rowAt) : NONE_READ,
    [grouped, placed, rowAt, loaded],
  );
  const items = useMemo(
    () =>
      viewItems({
        total: props.total,
        levels: grouped ? groupLevels(props.groupBy, props.columns) : [],
        groups,
        readSoFar,
        collapsed,
        canAdd: props.canAdd,
      }),
    [
      props.total,
      props.groupBy,
      props.columns,
      props.canAdd,
      grouped,
      groups,
      readSoFar,
      collapsed,
    ],
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) =>
      items[index]?.type === "group" ? HEADER_ESTIMATE : CARD_ESTIMATE,
    overscan: 6,
  });
  const lines = virtualizer.getVirtualItems();
  // The rows in view are read as they come into view; a grouped view that
  // lays out its rows as they are read reads on once its end is in view.
  let firstRow: number | undefined;
  let lastRow: number | undefined;
  for (const line of lines) {
    const item = items[line.index];
    if (item?.type !== "row") continue;
    firstRow ??= item.index;
    lastRow = item.index;
  }
  const lastLine = lines.at(-1)?.index ?? 0;
  const endInView = lastLine >= items.length - 1 - (props.canAdd ? 1 : 0);
  const moreToRead =
    grouped && !placed && readSoFar.length < props.total && endInView;
  const { ensure } = props;
  useEffect(() => {
    if (firstRow !== undefined && lastRow !== undefined) {
      ensure(firstRow, lastRow);
    }
    if (moreToRead) ensure(readSoFar.length, readSoFar.length);
  }, [ensure, firstRow, lastRow, moreToRead, readSoFar.length]);

  const limit = formatNumber(MAX_GROUPS, locale);
  const toggle = (key: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div
      ref={scrollRef}
      className="min-h-0 flex-1 overflow-y-auto"
      role="list"
      aria-label={t`Rows`}
    >
      <div
        className="relative w-full"
        style={{ height: virtualizer.getTotalSize() + 12 }}
      >
        {lines.map((line) => {
          const item = items[line.index];
          if (!item) return null;
          const row = item.type === "row" ? rowAt(item.index) : undefined;
          return (
            <div
              key={line.key}
              data-index={line.index}
              ref={virtualizer.measureElement}
              role="listitem"
              className="absolute top-0 right-0 left-0 px-3 pt-3"
              style={{ transform: `translateY(${String(line.start)}px)` }}
            >
              {item.type === "group" ? (
                <button
                  type="button"
                  aria-expanded={!collapsed.has(item.key)}
                  onClick={() => toggle(item.key)}
                  className="flex min-h-8 w-full items-center gap-2 text-left text-sm font-medium"
                  style={{ paddingLeft: item.depth * 16 }}
                >
                  {collapsed.has(item.key) ? (
                    <ChevronRight className="h-4 w-4 shrink-0" aria-hidden />
                  ) : (
                    <ChevronDown className="h-4 w-4 shrink-0" aria-hidden />
                  )}
                  <span
                    className={cn(
                      "min-w-0 truncate",
                      item.color &&
                        `opt-${item.color} rounded-full px-2 text-xs`,
                    )}
                  >
                    {item.label || t`(empty)`}
                  </span>
                  <span className="text-xs font-normal text-muted-foreground">
                    {item.count}
                  </span>
                </button>
              ) : item.type === "limit" ? (
                <p className="text-xs text-muted-foreground">
                  {t`The first ${limit} groups are shown: filter the view to see the others.`}
                </p>
              ) : item.type === "add" ? (
                <button
                  type="button"
                  onClick={() =>
                    void props.onCreate({}).then((id) => {
                      if (id) table.openRecord(id);
                    })
                  }
                  className="flex min-h-12 w-full items-center justify-center gap-1 rounded-sm border border-dashed border-border text-sm text-muted-foreground hover:bg-muted"
                >
                  <Plus className="h-4 w-4" aria-hidden />
                  {t`Add a row`}
                </button>
              ) : row ? (
                <button
                  type="button"
                  onClick={() => table.openRecord(row.id)}
                  className={cn(
                    "flex w-full flex-col gap-1 rounded-sm border border-border bg-card p-3 text-left hover:border-strong-border",
                    props.tintOf?.(row) && `row-tint-${props.tintOf(row)}`,
                  )}
                >
                  <span className="truncate font-medium">{title(row)}</span>
                  <CardFields row={row} columns={fields} />
                </button>
              ) : (
                <div
                  aria-hidden
                  className="flex min-h-20 flex-col gap-2 rounded-sm border border-border bg-card p-3"
                >
                  <span className="h-3 w-2/3 animate-pulse rounded-sm bg-muted" />
                  <span className="h-2.5 w-1/2 animate-pulse rounded-sm bg-muted" />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
