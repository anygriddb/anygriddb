import { Button, cn, Select } from "@anygriddb/ui";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useLocale } from "../../lib/i18n";
import type { RowItem } from "../../lib/types";
import { useTable } from "../table/table-context";
import { thisMonth } from "./calendar-view";
import {
  shiftPeriod,
  timelinePeriod,
  timelineScale,
  type TimelineScale,
} from "./timeline-period";
import { ColumnPicker, useRowTitle, type ViewProps } from "./view-common";
import { useLingui } from "@lingui/react/macro";

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
  const scrollRef = useRef<HTMLDivElement>(null);
  const dated = props.allColumns.filter(
    (column) => column.kind === "date" || column.kind === "datetime",
  );
  const startName =
    typeof props.config.startColumn === "string"
      ? props.config.startColumn
      : dated[0]?.name;
  const endName =
    typeof props.config.endColumn === "string"
      ? props.config.endColumn
      : undefined;
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
  if (!startName) {
    return (
      <p className="p-6 text-sm text-muted-foreground">
        {t`Add a date field to show the timeline.`}
      </p>
    );
  }
  const intl = locale === "fr" ? "fr-FR" : "en-GB";
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
  const min = utcDay(period.first);
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
  const today = utcDay(new Date(now));
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
            <option value="day">{t`Day`}</option>
            <option value="week">{t`Week`}</option>
            <option value="month">{t`Month`}</option>
          </Select>
        </label>
      </div>
      {props.total === 0 ? (
        <p className="p-6 text-sm text-muted-foreground">
          {t`No rows in this period.`}
        </p>
      ) : (
        <div ref={scrollRef} className="flex min-h-0 flex-1 overflow-auto">
          <div
            className="sticky left-0 z-10 w-56 shrink-0 border-r border-border bg-card"
            style={{ height }}
          >
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
          <div className="relative shrink-0" style={{ width, height }}>
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
  return (
    <button
      type="button"
      onClick={props.onOpen}
      className={cn(
        "absolute top-1.5 h-6 truncate rounded-md bg-primary px-2 text-left text-xs text-primary-foreground",
        from < props.min && "rounded-l-none",
        to + DAY > props.max && "rounded-r-none",
        props.tint && `row-tint-${props.tint}`,
      )}
      style={{
        left: ((left - props.min) / DAY) * props.perDay,
        width: Math.max(props.perDay, ((right - left) / DAY) * props.perDay),
      }}
    >
      {props.label}
    </button>
  );
}
