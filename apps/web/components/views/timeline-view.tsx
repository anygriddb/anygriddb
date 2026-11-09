import { cn, Select } from "@anygriddb/ui";
import { useMemo, useState } from "react";
import { useLocale } from "../../lib/i18n";
import type { RowItem } from "../../lib/types";
import { useTable } from "../table/table-context";
import { ColumnPicker, useRowTitle, type ViewProps } from "./view-common";
import { useLingui } from "@lingui/react/macro";

const DAY = 86_400_000;
const SCALE = { day: 40, week: 12, month: 4 } as const;

function toTime(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const time = Date.parse(value.length === 10 ? `${value}T00:00:00Z` : value);
  return Number.isFinite(time) ? time : null;
}

export function TimelineView(props: ViewProps) {
  const { t } = useLingui();
  const { locale } = useLocale();
  const table = useTable();
  const title = useRowTitle();
  // Today, as of when the view opened: the axis does not move as it renders.
  const [now] = useState(Date.now);
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
  const scale =
    (props.config.timelineScale as keyof typeof SCALE | undefined) ?? "week";
  // The scale comes from stored JSON: an unknown one falls back to weeks.
  const perDay =
    (SCALE as Partial<Record<string, number>>)[scale] ?? SCALE.week;
  const bars = useMemo(
    () =>
      props.rows.flatMap((row) => {
        const from = startName ? toTime(row[startName as keyof RowItem]) : null;
        if (from === null) return [];
        const to = endName
          ? (toTime(row[endName as keyof RowItem]) ?? from)
          : from;
        return [{ row, from, to: Math.max(to, from) }];
      }),
    [props.rows, startName, endName],
  );
  if (!startName) {
    return (
      <p className="p-6 text-sm text-muted-foreground">
        {t`Add a date field to show the timeline.`}
      </p>
    );
  }
  const min = Math.min(...bars.map((bar) => bar.from), now) - 3 * DAY;
  const max = Math.max(...bars.map((bar) => bar.to), now) + 14 * DAY;
  const days = Math.ceil((max - min) / DAY);
  const width = days * perDay;
  const months: Array<{ left: number; label: string }> = [];
  for (let time = min; time < max; time += DAY) {
    const date = new Date(time);
    if (date.getUTCDate() === 1 || time === min) {
      months.push({
        left: ((time - min) / DAY) * perDay,
        label: new Intl.DateTimeFormat(locale === "fr" ? "fr-FR" : "en-GB", {
          month: "short",
          year: "numeric",
        }).format(date),
      });
    }
  }
  const today = ((now - min) / DAY) * perDay;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-4 border-b border-border px-4 py-1.5">
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
                timelineScale: event.target.value as keyof typeof SCALE,
              })
            }
          >
            <option value="day">{t`Day`}</option>
            <option value="week">{t`Week`}</option>
            <option value="month">{t`Month`}</option>
          </Select>
        </label>
      </div>
      <div className="flex min-h-0 flex-1 overflow-auto">
        <div className="sticky left-0 z-10 w-56 shrink-0 border-r border-border bg-card">
          <div className="h-8 border-b border-border" />
          {bars.map(({ row }) => (
            <button
              key={row.id}
              type="button"
              onClick={() => table.openRecord(row.id)}
              className="block h-9 w-full truncate border-b border-border px-3 text-left text-sm hover:bg-muted"
            >
              {title(row)}
            </button>
          ))}
        </div>
        <div className="relative shrink-0" style={{ width }}>
          <div className="sticky top-0 z-[5] h-8 border-b border-border bg-muted">
            {months.map((month) => (
              <span
                key={month.left}
                className="absolute top-1.5 border-l border-border pl-1 text-xs text-muted-foreground capitalize"
                style={{ left: month.left }}
              >
                {month.label}
              </span>
            ))}
          </div>
          <div
            className="absolute top-8 bottom-0 w-px bg-primary/60"
            style={{ left: today }}
            aria-hidden
          />
          {bars.map(({ row, from, to }) => (
            <div
              key={row.id}
              className="relative h-9 border-b border-border/60"
            >
              <button
                type="button"
                onClick={() => table.openRecord(row.id)}
                className={cn(
                  "absolute top-1.5 h-6 truncate rounded-md bg-primary px-2 text-left text-xs text-primary-foreground shadow-sm",
                )}
                style={{
                  left: ((from - min) / DAY) * perDay,
                  width: Math.max(perDay, ((to - from) / DAY + 1) * perDay),
                }}
              >
                {title(row)}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
