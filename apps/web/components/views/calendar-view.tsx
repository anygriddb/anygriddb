import { Button, cn } from "@anygriddb/ui";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useRef } from "react";
import { useRowDrag, useRowDrop } from "../../lib/drag";
import { useLocale } from "../../lib/i18n";
import type { FilterGroup } from "@anygriddb/core";
import type { CatalogColumn, RowItem } from "../../lib/types";
import { useTable } from "../table/table-context";
import {
  ColumnPicker,
  useRowTitle,
  ViewSetupPrompt,
  type ViewProps,
} from "./view-common";
import { useLingui } from "@lingui/react/macro";
import { CalendarFeedButton } from "./calendar-feed";

/** Events a day shows; the others are counted under them. */
const SHOWN = 6;

function isoDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function dayOf(value: unknown, withTime: boolean): string | null {
  if (typeof value !== "string") return null;
  return withTime ? isoDay(new Date(value)) : value.slice(0, 10);
}

function Event({
  row,
  label,
  draggable,
  tint,
}: {
  row: RowItem;
  label: string;
  draggable: boolean;
  tint?: string;
}) {
  const table = useTable();
  // By mouse or touch; from the keyboard, the date is edited in the record.
  const { dragProps, isDragging } = useRowDrag(row.id, label, draggable);
  return (
    <button
      type="button"
      draggable={dragProps.draggable}
      onDragStart={dragProps.onDragStart}
      onDrag={dragProps.onDrag}
      onDragEnd={dragProps.onDragEnd}
      style={isDragging ? { opacity: 0.5 } : undefined}
      onClick={(event) => {
        event.stopPropagation();
        table.openRecord(row.id);
      }}
      className={cn(
        "w-full shrink-0 truncate rounded bg-accent px-1.5 py-0.5 text-left text-xs text-accent-foreground",
        tint && `row-tint-${tint}`,
      )}
    >
      {label}
    </button>
  );
}

function Day({
  day,
  inMonth,
  today,
  children,
  onCreate,
  onMove,
}: {
  day: string;
  inMonth: boolean;
  today: boolean;
  children: React.ReactNode;
  onCreate?: () => void;
  /** An event was dropped here: move row `rowId` to `day`. */
  onMove: (rowId: string, day: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { dropProps, isDropTarget } = useRowDrop(ref, (rowId) =>
    onMove(rowId, day),
  );
  return (
    <div
      ref={ref}
      {...dropProps}
      onDoubleClick={onCreate}
      className={cn(
        "flex min-h-28 flex-col gap-1 overflow-hidden border-r border-b border-border p-1",
        !inMonth && "bg-muted/50 text-muted-foreground",
        isDropTarget && "bg-selection",
      )}
    >
      <span
        className={cn(
          "self-end rounded-full px-1.5 text-xs",
          today && "bg-primary text-primary-foreground",
        )}
      >
        {Number(day.slice(8, 10))}
      </span>
      {children}
    </div>
  );
}

/** The field a calendar places rows by: the view's, else the first date. */
export function calendarStart(
  allColumns: readonly CatalogColumn[],
  config: Record<string, unknown>,
): CatalogColumn | undefined {
  const dated = allColumns.filter(
    (column) => column.kind === "date" || column.kind === "datetime",
  );
  const name =
    typeof config.startColumn === "string"
      ? config.startColumn
      : dated[0]?.name;
  return allColumns.find((column) => column.name === name);
}

/** The first of the current month. */
export function thisMonth(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

/** The six weeks a month's page shows, Monday first. */
export function calendarDays(month: Date): Date[] {
  const first = new Date(month);
  first.setDate(1 - ((first.getDay() + 6) % 7));
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(first);
    date.setDate(first.getDate() + index);
    return date;
  });
}

/**
 * The rows a month's page shows, filtered in the database: a calendar
 * reads a page of rows at most, so it asks for those of its six weeks.
 */
export function calendarFilter(start: CatalogColumn, month: Date): FilterGroup {
  const days = calendarDays(month);
  const from = isoDay(days[0] ?? month);
  const to = isoDay(days.at(-1) ?? month);
  return {
    conjunction: "and",
    conditions: [
      {
        column: start.name,
        op: "is_on_or_after",
        value: { mode: "exact", date: from },
      },
      {
        column: start.name,
        op: "is_on_or_before",
        value: { mode: "exact", date: to },
      },
    ],
  };
}

export function CalendarView(
  props: ViewProps & {
    month: Date;
    onMonth: (month: Date) => void;
    /** The view, for its private iCal feed. */
    viewId?: string;
  },
) {
  const { t } = useLingui();
  const { locale } = useLocale();
  const table = useTable();
  const title = useRowTitle(
    typeof props.config.titleColumn === "string"
      ? props.config.titleColumn
      : undefined,
  );
  const dated = props.allColumns.filter(
    (column) => column.kind === "date" || column.kind === "datetime",
  );
  const start = calendarStart(props.allColumns, props.config);
  const month = props.month;
  const setMonth = props.onMonth;
  if (!start) {
    return (
      <ViewSetupPrompt
        title={t`Add a date field to show the calendar.`}
        onAddField={props.onOpenFieldEditor}
      />
    );
  }
  const withTime = start.kind === "datetime";
  const editable =
    props.canEdit &&
    (start.fieldType === "date" || start.fieldType === "datetime");
  const days = calendarDays(month);
  const byDay = new Map<string, RowItem[]>();
  for (const row of props.rows) {
    const day = dayOf(row[start.name as keyof RowItem], withTime);
    if (day) byDay.set(day, [...(byDay.get(day) ?? []), row]);
  }
  const todayKey = isoDay(new Date());
  function valueFor(day: string, previous: unknown): string {
    if (!withTime) return day;
    const time =
      typeof previous === "string"
        ? new Date(previous)
        : new Date(`${day}T09:00:00`);
    const [year, monthPart, date] = day.split("-").map(Number);
    time.setFullYear(year ?? 2000, (monthPart ?? 1) - 1, date ?? 1);
    return time.toISOString();
  }
  function move(rowId: string, day: string) {
    if (!start) return;
    const row = props.rows.find((item) => item.id === rowId);
    if (!row) return;
    if (dayOf(row[start.name as keyof RowItem], withTime) === day) return;
    void table.updateCells([
      {
        rowId: row.id,
        values: {
          [start.name]: valueFor(day, row[start.name as keyof RowItem]),
        },
      },
    ]);
  }
  const weekdays = Array.from({ length: 7 }, (_, index) =>
    new Intl.DateTimeFormat(locale === "fr" ? "fr-FR" : "en-GB", {
      weekday: "short",
    }).format(new Date(2024, 0, 1 + index)),
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-3 border-b border-border px-4 py-1.5">
        <Button
          size="icon"
          variant="ghost"
          aria-label={t`Previous month`}
          onClick={() =>
            setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))
          }
        >
          <ChevronLeft className="h-4 w-4" aria-hidden />
        </Button>
        <span className="w-40 text-center text-sm font-medium capitalize">
          {new Intl.DateTimeFormat(locale === "fr" ? "fr-FR" : "en-GB", {
            month: "long",
            year: "numeric",
          }).format(month)}
        </span>
        <Button
          size="icon"
          variant="ghost"
          aria-label={t`Next month`}
          onClick={() =>
            setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))
          }
        >
          <ChevronRight className="h-4 w-4" aria-hidden />
        </Button>
        <Button
          size="xs"
          variant="outline"
          onClick={() =>
            setMonth(
              new Date(new Date().getFullYear(), new Date().getMonth(), 1),
            )
          }
        >
          {t`Today`}
        </Button>
        <ColumnPicker
          label={t`Date`}
          value={start.name}
          columns={dated}
          onChange={(value) => props.onPatch({ startColumn: value })}
        />
        {props.viewId ? (
          <div className="ml-auto">
            <CalendarFeedButton viewId={props.viewId} />
          </div>
        ) : null}
      </div>
      <div className="grid grid-cols-7 border-l border-border text-xs text-muted-foreground">
        {weekdays.map((day) => (
          <div
            key={day}
            className="border-r border-b border-border px-2 py-1 capitalize"
          >
            {day}
          </div>
        ))}
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-7 overflow-y-auto border-l border-border">
        {days.map((date) => {
          const key = isoDay(date);
          return (
            <Day
              key={key}
              day={key}
              inMonth={date.getMonth() === month.getMonth()}
              today={key === todayKey}
              onMove={move}
              onCreate={
                editable
                  ? () =>
                      void props
                        .onCreate({ [start.name]: valueFor(key, null) })
                        .then((id) => id && table.openRecord(id))
                  : undefined
              }
            >
              {(byDay.get(key) ?? []).slice(0, SHOWN).map((row) => (
                <Event
                  key={row.id}
                  row={row}
                  label={title(row)}
                  draggable={editable}
                  tint={props.tintOf?.(row)}
                />
              ))}
              {(props.counts?.get(key) ?? byDay.get(key)?.length ?? 0) >
              SHOWN ? (
                <span className="text-[10px] text-muted-foreground">
                  +
                  {(props.counts?.get(key) ?? byDay.get(key)?.length ?? 0) -
                    Math.min(SHOWN, byDay.get(key)?.length ?? 0)}
                </span>
              ) : null}
            </Day>
          );
        })}
      </div>
    </div>
  );
}
