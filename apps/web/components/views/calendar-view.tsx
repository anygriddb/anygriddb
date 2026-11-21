import { Button, cn } from "@anygriddb/ui";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useRef, type KeyboardEvent } from "react";
import { useRowDrag, useRowDrop } from "../../lib/drag";
import { useLocale } from "../../lib/i18n";
import type { FilterGroup } from "@anygriddb/core";
import type { CatalogColumn, RowItem } from "../../lib/types";
import { canDateBy, startField } from "../table/field-roles";
import { useTable } from "../table/table-context";
import {
  ColumnPicker,
  useRowTitle,
  ViewSetupPrompt,
  type ViewProps,
} from "./view-common";
import { useLingui } from "@lingui/react/macro";
import { CalendarFeedButton } from "./calendar-feed";
import { intlLocale } from "../../lib/format";
import { dayToAdd, dayValue, isoDay, monthDays } from "./view-days";

/** Events a day shows; the others are counted under them. */
const SHOWN = 6;

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
      {...dragProps}
      style={isDragging ? { opacity: 0.5 } : undefined}
      onClick={(event) => {
        event.stopPropagation();
        table.openRecord(row.id);
      }}
      className={cn(
        "min-h-6 w-full shrink-0 truncate rounded bg-accent px-1.5 py-0.5 text-left text-xs text-accent-foreground",
        tint && `row-tint-${tint}`,
      )}
    >
      {label}
    </button>
  );
}

/** How far an arrow key moves the chosen day. */
const DAY_STEPS: Record<string, number> = {
  ArrowLeft: -1,
  ArrowRight: 1,
  ArrowUp: -7,
  ArrowDown: 7,
};

function Day({
  day,
  name,
  inMonth,
  today,
  picked,
  tabStop,
  children,
  onCreate,
  onMove,
  onPick,
  onStep,
}: {
  day: string;
  /** The day in full, as it is read out: its events are heard under it. */
  name: string;
  inMonth: boolean;
  today: boolean;
  /** The day chosen for "Add a row" from the toolbar. */
  picked: boolean;
  /** The month's one stop for the Tab key. */
  tabStop: boolean;
  children: React.ReactNode;
  onCreate?: () => void;
  /** An event was dropped here: move row `rowId` to `day`. */
  onMove: (rowId: string, day: string) => void;
  /** Only a day of the month, for someone who may add a row, is chosen. */
  onPick?: () => void;
  onStep: (by: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { dropProps, isDropTarget } = useRowDrop(ref, (rowId) =>
    onMove(rowId, day),
  );
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    // What the day holds keeps its keys: Enter on an event opens it.
    if (!onPick || event.target !== event.currentTarget) return;
    const by = DAY_STEPS[event.key];
    if (by !== undefined) {
      event.preventDefault();
      onStep(by);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onCreate?.();
    }
  }
  return (
    <div
      ref={ref}
      {...dropProps}
      role="group"
      aria-label={name}
      aria-current={today ? "date" : undefined}
      data-day={day}
      tabIndex={onPick ? (tabStop ? 0 : -1) : undefined}
      onFocus={(event) => {
        if (event.target === event.currentTarget) onPick?.();
      }}
      onClick={() => onPick?.()}
      onKeyDown={onKeyDown}
      onDoubleClick={onCreate}
      className={cn(
        "flex min-h-28 flex-col gap-1 overflow-hidden border-r border-b border-border p-1 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring",
        !inMonth && "bg-muted/50 text-muted-foreground",
        isDropTarget && "bg-selection",
        picked && "bg-selection/40",
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

/** The first of the current month. */
export function thisMonth(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

/** The six weeks a month's page shows, Monday first. */
function calendarDays(month: Date): Date[] {
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
    /** Day chosen for the toolbar's "Add a row", as a date field keeps it. */
    pickedDay: string | null;
    onPickDay: (day: string) => void;
    /** The view, for its private iCal feed. */
    viewId?: string;
  },
) {
  const { t } = useLingui();
  const { locale } = useLocale();
  const table = useTable();
  const monthRef = useRef<HTMLDivElement>(null);
  const title = useRowTitle(
    typeof props.config.titleColumn === "string"
      ? props.config.titleColumn
      : undefined,
  );
  const dated = props.allColumns.filter(canDateBy);
  const start = startField(props.config, props.allColumns);
  const month = props.month;
  const setMonth = props.onMonth;
  if (!start) {
    // A date is there, kept in AnyGridDB beside a client's rows: it
    // cannot choose the rows of a month, and another one would not either.
    return props.allColumns.some(
      (column) => column.kind === "date" || column.kind === "datetime",
    ) ? (
      <ViewSetupPrompt
        title={t`A field kept in AnyGridDB cannot place the rows of a live client table on a calendar.`}
        description={t`A calendar needs a date field that the client's database holds.`}
      />
    ) : (
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
  // The day "Add a row" would take is where the keyboard enters the month.
  const tabStop = dayToAdd(monthDays(month), new Date(), props.pickedDay);
  function stepDay(index: number, by: number) {
    const next = days[index + by];
    if (!next || next.getMonth() !== month.getMonth()) return;
    const key = isoDay(next);
    props.onPickDay(key);
    monthRef.current
      ?.querySelector<HTMLElement>(`[data-day="${key}"]`)
      ?.focus();
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
          [start.name]: dayValue(
            day,
            withTime,
            row[start.name as keyof RowItem],
          ),
        },
      },
    ]);
  }
  const intl = intlLocale(locale);
  const weekdays = Array.from({ length: 7 }, (_, index) =>
    new Intl.DateTimeFormat(intl, {
      weekday: "short",
    }).format(new Date(2024, 0, 1 + index)),
  );
  const dayName = new Intl.DateTimeFormat(intl, { dateStyle: "full" });
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-1.5">
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
          {new Intl.DateTimeFormat(intl, {
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
      {/* A week is as tall as its fullest day, and the month scrolls: a
          week of the height left to it cut the events past its edge. */}
      <div
        ref={monthRef}
        className="grid min-h-0 flex-1 auto-rows-[minmax(min-content,auto)] grid-cols-7 overflow-y-auto border-l border-border"
      >
        {days.map((date, index) => {
          const key = isoDay(date);
          const inMonth = date.getMonth() === month.getMonth();
          return (
            <Day
              key={key}
              day={key}
              name={dayName.format(date)}
              inMonth={inMonth}
              today={key === todayKey}
              picked={props.pickedDay === key}
              tabStop={key === tabStop}
              {...(editable && inMonth
                ? { onPick: () => props.onPickDay(key) }
                : {})}
              onStep={(by) => stepDay(index, by)}
              onMove={move}
              onCreate={
                editable
                  ? () =>
                      void props
                        .onCreate({
                          [start.name]: dayValue(key, withTime, null),
                        })
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
