import {
  aggregateFunctionsFor,
  cellText,
  isDecimalString,
} from "@anygriddb/core";
import {
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@anygriddb/ui";
import { marginColumn } from "./margin-column";
import { formatDate, formatNumber } from "../../lib/format";
import { useLocale } from "../../lib/i18n";
import type { CatalogColumn } from "../../lib/types";
import { useLingui } from "@lingui/react/macro";
import type { MessageDescriptor } from "@lingui/core";
import { msg, plural } from "@lingui/core/macro";
import { raw } from "../../lib/known-text";

export const AGGREGATE_LABELS: Record<string, MessageDescriptor> = {
  count_all: msg`Number`,
  count_empty: msg`Empty`,
  count_filled: msg`Filled`,
  count_unique: msg`Unique`,
  percent_empty: msg`% empty`,
  percent_filled: msg`% filled`,
  percent_unique: msg`% unique`,
  sum: msg`Sum`,
  avg: msg`Average`,
  median: msg`Median`,
  min: msg`Min`,
  max: msg`Max`,
  std_dev: msg`Standard deviation`,
  earliest: msg`Earliest`,
  latest: msg`Latest`,
  date_range_days: msg`Range (days)`,
  checked: msg`Checked`,
  unchecked: msg`Unchecked`,
  percent_checked: msg`% checked`,
  percent_unchecked: msg`% unchecked`,
};

function formatAggregate(
  value: unknown,
  fn: string,
  column: CatalogColumn,
  locale: "fr" | "en",
): string {
  if (value === null || value === undefined) return "—";
  // Sums, means, and extremes of exact numbers come as decimal text.
  if (typeof value === "number" || isDecimalString(value)) {
    if (fn.startsWith("percent"))
      return `${formatNumber(value, locale, { precision: 1 })} %`;
    if (
      fn === "sum" ||
      fn === "avg" ||
      fn === "median" ||
      fn === "min" ||
      fn === "max" ||
      fn === "std_dev"
    ) {
      return formatNumber(
        value,
        locale,
        (column.config as { number?: Parameters<typeof formatNumber>[2] })
          .number,
      );
    }
    return formatNumber(value, locale, {
      precision: fn === "date_range_days" ? 1 : 0,
    });
  }
  if (typeof value === "string" && (fn === "earliest" || fn === "latest")) {
    return formatDate(value, locale, undefined, column.kind === "datetime");
  }
  return cellText(value);
}

export function GridFooter(props: {
  columns: readonly CatalogColumn[];
  widths: readonly number[];
  offsets: readonly number[];
  frozenCount: number;
  virtualColumns: readonly number[];
  padStart: number;
  width: number;
  total: number;
  /** The total is a large client table's estimate: it may be counted. */
  estimated?: { onCount: () => void };
  aggregations: Readonly<Record<string, string>>;
  values: ReadonlyArray<unknown> | undefined;
  onAggregate: (column: string, fn: string | null) => void;
}) {
  const { t } = useLingui();
  const { locale } = useLocale();
  const names = Object.keys(props.aggregations);
  function cell(index: number) {
    const column = props.columns[index];
    if (!column) return null;
    const fn = props.aggregations[column.name];
    const valueIndex = fn ? names.indexOf(column.name) : -1;
    const frozen = index < props.frozenCount;
    return (
      <div
        key={column.name}
        role="gridcell"
        aria-colindex={index + 2}
        className={cn("flex shrink-0", frozen && "sticky z-[7]")}
        style={{
          width: props.widths[index],
          left: frozen ? props.offsets[index] : undefined,
        }}
      >
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label={
              fn ? undefined : t`Summary of ${{ field: column.label }}`
            }
            className={cn(
              "flex h-full w-full items-center justify-end gap-1 border-t border-r border-border bg-muted px-2 text-xs text-muted-foreground hover:bg-card",
              index === marginColumn(props.frozenCount) && "border-r-margin",
            )}
          >
            {fn ? (
              <>
                <span className="truncate">
                  {t(AGGREGATE_LABELS[fn] ?? raw(fn))}
                </span>
                <span className="font-medium text-foreground tabular-nums">
                  {formatAggregate(
                    props.values?.[valueIndex],
                    fn,
                    column,
                    locale,
                  )}
                </span>
              </>
            ) : (
              <span className="opacity-0 hover:opacity-100">{t`Summary`}</span>
            )}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onSelect={() => props.onAggregate(column.name, null)}
            >
              {t`None`}
            </DropdownMenuItem>
            {aggregateFunctionsFor(column.kind).map((option) => (
              <DropdownMenuItem
                key={option}
                onSelect={() => props.onAggregate(column.name, option)}
              >
                {t(AGGREGATE_LABELS[option] ?? raw(option))}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    );
  }
  // The grid's last row: a summary under each field.
  return (
    <div
      role="row"
      aria-rowindex={props.total + 2}
      className="sticky bottom-0 z-[8] flex"
      style={{ width: props.width, height: 32, top: "auto" }}
    >
      <div
        role="rowheader"
        aria-colindex={1}
        className={cn(
          "sticky left-0 z-[9] flex shrink-0 items-center border-t border-r border-border bg-muted px-2 text-xs text-muted-foreground",
          marginColumn(props.frozenCount) === -1 && "border-r-margin",
        )}
        style={{ width: 72 }}
      >
        {props.estimated ? (
          <button
            type="button"
            className="underline decoration-dotted underline-offset-2 hover:text-foreground"
            title={t`Total estimated by the client's database: click to count exactly`}
            onClick={props.estimated.onCount}
          >
            {plural(props.total, { one: `≈ # row`, other: `≈ # rows` })}
          </button>
        ) : (
          plural(props.total, { one: `# row`, other: `# rows` })
        )}
      </div>
      {Array.from({ length: props.frozenCount }, (_, index) => cell(index))}
      <div
        aria-hidden
        className="shrink-0 border-t border-border bg-muted"
        style={{ width: props.padStart }}
      />
      {props.virtualColumns.map((index) => cell(index))}
      <div aria-hidden className="flex-1 border-t border-border bg-muted" />
    </div>
  );
}
