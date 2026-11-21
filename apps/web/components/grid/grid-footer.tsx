import { aggregateFunctionsFor } from "@anygriddb/core";
import {
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Tooltip,
} from "@anygriddb/ui";
import { GUTTER, marginColumn } from "./margin-column";
import { AGGREGATE_LABELS } from "../../lib/aggregate-labels";
import { formatAggregate } from "../../lib/format";
import { useLocale } from "../../lib/i18n";
import type { CatalogColumn } from "../../lib/types";
import { useLingui } from "@lingui/react/macro";
import { plural } from "@lingui/core/macro";
import { raw } from "../../lib/known-text";

export function GridFooter(props: {
  columns: readonly CatalogColumn[];
  widths: readonly number[];
  offsets: readonly number[];
  frozenCount: number;
  virtualColumns: readonly number[];
  padStart: number;
  width: number;
  /** The column past the last field (the one that adds a field), if any. */
  trailingWidth: number;
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
              "flex h-full w-full items-center justify-end gap-1 border-t border-r border-t-strong-border border-r-rule bg-head px-2 text-xs text-muted-foreground hover:bg-muted",
              index === marginColumn(props.frozenCount) &&
                "border-r-2 border-r-margin",
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
          "sticky left-0 z-[9] flex shrink-0 items-center border-t border-r border-t-strong-border border-r-rule bg-head px-2 text-xs whitespace-nowrap text-muted-foreground",
          marginColumn(props.frozenCount) === -1 &&
            "border-r-2 border-r-margin",
        )}
        style={{ width: GUTTER }}
      >
        {props.estimated ? (
          <Tooltip
            content={t`Total estimated by the client's database: click to count exactly`}
          >
            <button
              type="button"
              className="min-h-6 underline decoration-dotted underline-offset-2 hover:text-foreground"
              onClick={props.estimated.onCount}
            >
              {plural(props.total, { one: `≈ # row`, other: `≈ # rows` })}
            </button>
          </Tooltip>
        ) : (
          plural(props.total, { one: `# row`, other: `# rows` })
        )}
      </div>
      {Array.from({ length: props.frozenCount }, (_, index) => cell(index))}
      <div
        aria-hidden
        className="shrink-0 border-t border-strong-border bg-head"
        style={{ width: props.padStart }}
      />
      {props.virtualColumns.map((index) => cell(index))}
      <div
        aria-hidden
        className="shrink-0 border-t border-strong-border bg-head"
        style={{ width: props.trailingWidth }}
      />
    </div>
  );
}
