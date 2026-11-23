import { Button, cn, Select } from "@anygriddb/ui";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useLocale } from "../../lib/i18n";
import { useNarrowScreen } from "../../lib/narrow-screen";
import type { RowItem } from "../../lib/types";
import { canDateBy, endField, startField } from "../table/field-roles";
import { useTable } from "../table/table-context";
import { thisMonth } from "./calendar-view";
import {
  barHoldsName,
  barTarget,
  namesWidth,
  openingScroll,
  shiftPeriod,
  timelinePeriod,
  timelineScale,
  type TimelineScale,
} from "./timeline-period";
import {
  ColumnPicker,
  useRowTitle,
  ViewSetupPrompt,
  type ViewProps,
} from "./view-common";
import { useLingui } from "@lingui/react/macro";
import { intlLocale } from "../../lib/format";

const DAY = 86_400_000;
const SCALE: Record<TimelineScale, number> = { day: 40, week: 12, month: 4 };
const ROW = 36;
const HEADER = 32;

function toTime(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const time = Date.parse(value.length === 10 ? `${value}T00:00:00Z` : value);
  return Number.isFinite(time) ? time : null;
}

function utcDay(date: Date): number {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
}

export function TimelineView(
  props: ViewProps & {
    /** A month inside the period shown. */
    focus: Date;
    onFocus: (focus: Date) => void;
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
  // Today, as of when the view opened: the axis does not move as it renders.
  const [now] = useState(Date.now);
  // The column of names beside the axis (its own pane: bars never sit under it).
  const names = namesWidth(useNarrowScreen());
  const scrollRef = useRef<HTMLDivElement>(null);
  const namesScrollRef = useRef<HTMLDivElement>(null);
  const dated = props.allColumns.filter(canDateBy);
  const startName = startField(props.config, props.allColumns)?.name;
  const endName = endField(props.config, props.allColumns)?.name;
  const scale = timelineScale(props.config.timelineScale);
  const perDay = SCALE[scale];
  const period = timelinePeriod(props.focus, scale);
  // Every row of the period has its line, read as it comes into view.
  // TanStack Virtual hands back a mutable instance, so the React Compiler
  // leaves this component as written.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: startName ? props.total : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW,
    overscan: 10,
  });
  const lines = virtualizer.getVirtualItems();
  const first = lines[0]?.index ?? 0;
  const last = lines.at(-1)?.index ?? 0;
  const { ensure } = props;
  useEffect(() => {
    if (lines.length > 0) ensure(first, last);
  }, [ensure, first, last, lines.length]);
  // A period opens on today when it holds it: once its rows are drawn,
  // and again when the period or the scale changes.
  const drawn = startName !== undefined && props.total > 0;
  const periodStart = utcDay(period.first);
  const todayIn = Math.round((utcDay(new Date(now)) - periodStart) / DAY);
  useEffect(() => {
    const axis = scrollRef.current;
    if (!drawn || !axis) return;
    axis.scrollLeft = openingScroll({
      today: todayIn >= 0 && todayIn < period.days ? todayIn : null,
      perDay,
      shown: axis.clientWidth,
    });
  }, [drawn, periodStart, period.days, todayIn, perDay]);
  // The axis's own scrollbar takes height from it: the names get as much
  // more to scroll, or the two panes stop short of the last line.
  const [axisBar, setAxisBar] = useState(0);
  useEffect(() => {
    const axis = scrollRef.current;
    if (!drawn || !axis) return;
    const observer = new ResizeObserver(() =>
      setAxisBar(axis.offsetHeight - axis.clientHeight),
    );
    observer.observe(axis);
    return () => observer.disconnect();
  }, [drawn]);
  // Same setup prompt as the calendar and the kanban: the reason, and a
  // way to add the field when the person may change the schema.
  if (!startName) {
    return props.allColumns.some(
      (column) => column.kind === "date" || column.kind === "datetime",
    ) ? (
      <ViewSetupPrompt
        title={t`A field kept in AnyGridDB cannot place the rows of a live client table on a timeline.`}
        description={t`A timeline needs a date field that the client's database holds.`}
      />
    ) : (
      <ViewSetupPrompt
        title={t`Add a date field to show the timeline.`}
        onAddField={props.onOpenFieldEditor}
      />
    );
  }
  const intl = intlLocale(locale);
  const lastDay = new Date(
    period.next.getFullYear(),
    period.next.getMonth(),
    0,
  );
  const periodLabel =
    scale === "day"
      ? new Intl.DateTimeFormat(intl, {
          month: "long",
          year: "numeric",
        }).format(period.first)
      : scale === "week"
        ? new Intl.DateTimeFormat(intl, {
            month: "short",
            year: "numeric",
          }).formatRange(period.first, lastDay)
        : new Intl.DateTimeFormat(intl, { year: "numeric" }).format(
            period.first,
          );
  const min = periodStart;
  const max = min + period.days * DAY;
  const width = period.days * perDay;
  const ticks: Array<{ left: number; label: string }> = [];
  for (let index = 0; index < period.days; index += 1) {
    const date = new Date(min + index * DAY);
    if (scale === "day") {
      ticks.push({ left: index * perDay, label: String(date.getUTCDate()) });
    } else if (date.getUTCDate() === 1) {
      ticks.push({
        left: index * perDay,
        label: new Intl.DateTimeFormat(intl, {
          month: "short",
          timeZone: "UTC",
        }).format(date),
      });
    }
  }
  const today = min + todayIn * DAY;
  const height = HEADER + virtualizer.getTotalSize();
  const step = (direction: -1 | 1) =>
    props.onFocus(shiftPeriod(props.focus, scale, direction));
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-1.5">
        <Button
          size="icon"
          variant="ghost"
          aria-label={t`Previous period`}
          onClick={() => step(-1)}
        >
          <ChevronLeft className="h-4 w-4" aria-hidden />
        </Button>
        <span className="min-w-40 text-center text-sm font-medium capitalize">
          {periodLabel}
        </span>
        <Button
          size="icon"
          variant="ghost"
          aria-label={t`Next period`}
          onClick={() => step(1)}
        >
          <ChevronRight className="h-4 w-4" aria-hidden />
        </Button>
        <Button
          size="xs"
          variant="outline"
          onClick={() => props.onFocus(thisMonth())}
        >
          {t`Today`}
        </Button>
        <ColumnPicker
          label={t`Start`}
          value={startName}
          columns={dated}
          onChange={(value) => props.onPatch({ startColumn: value })}
        />
        <ColumnPicker
          label={t`End`}
          value={endName}
          columns={dated}
          allowNone
          onChange={(value) => props.onPatch({ endColumn: value })}
        />
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          {t`Scale`}
          <Select
            className="h-7 w-28 text-xs"
            value={scale}
            onChange={(event) =>
              props.onPatch({
                timelineScale: timelineScale(event.target.value),
              })
            }
          >
            <option value="day">{t`Month`}</option>
            <option value="week">{t`Quarter`}</option>
            <option value="month">{t`Year`}</option>
          </Select>
        </label>
      </div>
      {props.total === 0 ? (
        <p className="p-6 text-sm text-muted-foreground">
          {t`No rows in this period.`}
        </p>
      ) : (
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <div
            ref={namesScrollRef}
            className="shrink-0 overflow-x-hidden overflow-y-auto border-r border-border bg-card [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
            style={{ width: names }}
            onScroll={(event) => {
              const axis = scrollRef.current;
              if (axis && axis.scrollTop !== event.currentTarget.scrollTop) {
                axis.scrollTop = event.currentTarget.scrollTop;
              }
            }}
          >
            <div className="relative" style={{ height: height + axisBar }}>
              <div className="sticky top-0 z-[5] h-8 border-b border-border bg-card" />
              {lines.map((line) => {
                const row = props.rowAt(line.index);
                return (
                  <div
                    key={line.key}
                    className="absolute left-0 w-full"
                    style={{ top: HEADER + line.start, height: ROW }}
                  >
                    {row ? (
                      <button
                        type="button"
                        onClick={() => table.openRecord(row.id)}
                        className="block h-full w-full truncate border-b border-border px-3 text-left text-sm hover:bg-muted"
                      >
                        {title(row)}
                      </button>
                    ) : (
                      <span
                        aria-hidden
                        className="m-3 block h-3 w-2/3 animate-pulse rounded-sm bg-muted"
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
          <div
            ref={scrollRef}
            className="min-h-0 flex-1 overflow-auto"
            onScroll={(event) => {
              const namesPane = namesScrollRef.current;
              if (
                namesPane &&
                namesPane.scrollTop !== event.currentTarget.scrollTop
              ) {
                namesPane.scrollTop = event.currentTarget.scrollTop;
              }
            }}
          >
            <div className="relative" style={{ width, height }}>
              <div className="sticky top-0 z-[5] h-8 border-b border-border bg-muted">
                {ticks.map((tick) => (
                  <span
                    key={tick.left}
                    className="absolute top-1.5 border-l border-border pl-1 text-xs text-muted-foreground capitalize"
                    style={{ left: tick.left }}
                  >
                    {tick.label}
                  </span>
                ))}
              </div>
              {today >= min && today < max ? (
                <div
                  className="absolute top-8 bottom-0 w-px bg-primary/60"
                  style={{ left: ((today - min) / DAY) * perDay }}
                  aria-hidden
                />
              ) : null}
              {lines.map((line) => {
                const row = props.rowAt(line.index);
                return (
                  <div
                    key={line.key}
                    className="absolute left-0 w-full border-b border-border/60"
                    style={{ top: HEADER + line.start, height: ROW }}
                  >
                    {row ? (
                      <Bar
                        row={row}
                        label={title(row)}
                        startName={startName}
                        endName={endName}
                        min={min}
                        max={max}
                        perDay={perDay}
                        tint={props.tintOf?.(row)}
                        onOpen={() => table.openRecord(row.id)}
                      />
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Bar(props: {
  row: RowItem;
  label: string;
  startName: string;
  endName: string | undefined;
  min: number;
  max: number;
  perDay: number;
  tint: string | undefined;
  onOpen: () => void;
}) {
  const from = toTime(props.row[props.startName as keyof RowItem]);
  if (from === null) return null;
  const to = Math.max(
    props.endName
      ? (toTime(props.row[props.endName as keyof RowItem]) ?? from)
      : from,
    from,
  );
  // A bar that crosses an edge of the period is cut there, square.
  const left = Math.max(from, props.min);
  const right = Math.min(to + DAY, props.max);
  if (right <= left) return null;
  const width = Math.max(props.perDay, ((right - left) / DAY) * props.perDay);
  const named = barHoldsName(width);
  // The button is what opens the row, never narrower than a pointer's
  // target; the bar inside it is as wide as its days.
  return (
    <button
      type="button"
      onClick={props.onOpen}
      className="absolute top-1.5 h-6 text-left text-xs"
      style={{
        left: ((left - props.min) / DAY) * props.perDay,
        width: barTarget(width),
      }}
    >
      <span
        className={cn(
          "block h-full truncate rounded-md bg-primary leading-6 text-primary-foreground",
          named && "px-2",
          from < props.min && "rounded-l-none",
          to + DAY > props.max && "rounded-r-none",
          props.tint && `row-tint-${props.tint}`,
        )}
        style={{ width }}
      >
        {/* Too short for the name, a bar keeps it for a screen reader. */}
        <span className={named ? undefined : "sr-only"}>{props.label}</span>
      </span>
    </button>
  );
}
