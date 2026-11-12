import { cellText, rowError } from "@anygriddb/core";

import {
  Button,
  Checkbox,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
} from "@anygriddb/ui";
import { LayoutList } from "lucide-react";
import { cellDisplay } from "../../lib/format";
import type { CatalogColumn, RowItem } from "../../lib/types";
import { CellValueView } from "../fields/cell-value";
import { useTable } from "../table/table-context";
import type { ViewPatch } from "../table/view-toolbar";
import type { Groups } from "../grid/use-rows";
import { useLingui } from "@lingui/react/macro";

export type ViewProps = {
  /** The rows read so far, in the view's order. */
  rows: readonly RowItem[];
  total: number;
  /** A row by its place in the view, once its page is read. */
  rowAt: (index: number) => RowItem | undefined;
  /** Reads the pages that hold these places, if not read yet. */
  ensure: (start: number, end: number) => void;
  columns: readonly CatalogColumn[];
  allColumns: readonly CatalogColumn[];
  config: Record<string, unknown>;
  canEdit: boolean;
  onPatch: (patch: ViewPatch) => void;
  onCreate: (values: Record<string, unknown>) => Promise<string | undefined>;
  /**
   * Rows per value of the field a view groups by, counted by the database:
   * a view shows at most a page of rows, the counts are of them all.
   */
  counts?: ReadonlyMap<string, number>;
  /** Where each group starts, for a view that reads its rows grouped. */
  groups?: Groups;
  /** Optional row tint from the view colour settings. */
  tintOf?: (row: RowItem) => string | undefined;
};

/** Title text for a card/row: `titleColumn` when set, else the primary field. */
export function useRowTitle(titleColumn?: string) {
  const table = useTable();
  const primary = table.table.columns.find((column) => column.isPrimary);
  const chosen = titleColumn
    ? (table.table.columns.find((column) => column.name === titleColumn) ??
      primary)
    : primary;
  return (row: RowItem) => {
    if (!chosen) return `#${cellText(row.ag_seq)}`;
    return (
      cellDisplay(
        row[chosen.name as keyof RowItem],
        chosen,
        table.locale,
        table.people,
      ) || `#${cellText(row.ag_seq)}`
    );
  };
}

export function ColumnPicker({
  label,
  value,
  columns,
  onChange,
  allowNone,
}: {
  label: string;
  value: string | undefined;
  columns: readonly CatalogColumn[];
  onChange: (value: string | null) => void;
  allowNone?: boolean;
}) {
  const { t } = useLingui();
  return (
    <label className="flex items-center gap-2 text-xs text-muted-foreground">
      {label}
      <Select
        className="h-7 w-44 text-xs"
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value || null)}
      >
        {allowNone || !value ? <option value="">{t`None`}</option> : null}
        {columns.map((column) => (
          <option key={column.name} value={column.name}>
            {column.label}
          </option>
        ))}
      </Select>
    </label>
  );
}

export function CardFields({
  row,
  columns,
}: {
  row: RowItem;
  columns: readonly CatalogColumn[];
}) {
  const table = useTable();
  return (
    <dl className="mt-1 flex flex-col gap-1">
      {columns.map((column) => {
        const value = row[column.name as keyof RowItem];
        const error = rowError(row, column.name);
        if (
          error === null &&
          (value === null ||
            value === undefined ||
            (Array.isArray(value) && value.length === 0))
        )
          return null;
        return (
          <div key={column.name} className="min-w-0">
            <dt className="text-[11px] text-muted-foreground">
              {column.label}
            </dt>
            <dd className="flex min-w-0 text-xs">
              <CellValueView
                value={value}
                column={column}
                locale={table.locale}
                people={table.people}
                error={error}
              />
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

export function cardColumns(
  config: Record<string, unknown>,
  columns: readonly CatalogColumn[],
  exclude: readonly string[],
) {
  const chosen = Array.isArray(config.cardFields)
    ? (config.cardFields as string[])
    : undefined;
  const list = chosen
    ? chosen
        .map((name) => columns.find((column) => column.name === name))
        .filter((column): column is CatalogColumn => Boolean(column))
    : columns
        .filter((column) => !column.isPrimary && !exclude.includes(column.name))
        .slice(0, 4);
  return list;
}

/** Pick which fields appear on kanban/gallery cards. */
export function CardFieldsPicker({
  columns,
  exclude,
  value,
  onChange,
}: {
  columns: readonly CatalogColumn[];
  exclude: readonly string[];
  value: readonly string[] | undefined;
  onChange: (fields: string[] | null) => void;
}) {
  const { t } = useLingui();
  const choices = columns.filter((column) => !exclude.includes(column.name));
  const selected = new Set(
    value ??
      choices
        .filter((column) => !column.isPrimary)
        .slice(0, 4)
        .map((column) => column.name),
  );
  const custom = value !== undefined;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          size="xs"
          variant={custom ? "outline" : "ghost"}
          className="h-7 gap-1 text-xs"
        >
          <LayoutList className="h-3.5 w-3.5" aria-hidden />
          {t`Card fields`}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64">
        <p className="mb-2 text-xs font-medium">{t`Shown on cards`}</p>
        <ul className="flex max-h-64 flex-col gap-0.5 overflow-y-auto">
          {choices.map((column) => (
            <li key={column.name}>
              <label className="flex items-center gap-2 rounded px-1 py-1 text-sm hover:bg-muted">
                <Checkbox
                  checked={selected.has(column.name)}
                  onChange={(event) => {
                    const next = new Set(selected);
                    if (event.target.checked) next.add(column.name);
                    else next.delete(column.name);
                    onChange([...next]);
                  }}
                />
                <span className="truncate">{column.label}</span>
              </label>
            </li>
          ))}
        </ul>
        <Button
          size="xs"
          variant="outline"
          className="mt-2"
          onClick={() => onChange(null)}
        >
          {t`Use default fields`}
        </Button>
      </PopoverContent>
    </Popover>
  );
}
