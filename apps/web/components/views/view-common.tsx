import { cellText, rowError } from "@anygriddb/core";

import { Select } from "@anygriddb/ui";
import { cellDisplay } from "../../lib/format";
import type { CatalogColumn, RowItem } from "../../lib/types";
import { CellValueView } from "../fields/cell-value";
import { useTable } from "../table/table-context";
import type { ViewPatch } from "../table/view-toolbar";
import { useLingui } from "@lingui/react/macro";

export type ViewProps = {
  rows: readonly RowItem[];
  total: number;
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
};

export function useRowTitle() {
  const table = useTable();
  const primary = table.table.columns.find((column) => column.isPrimary);
  return (row: RowItem) => {
    if (!primary) return `#${cellText(row.ag_seq)}`;
    return (
      cellDisplay(
        row[primary.name as keyof RowItem],
        primary,
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
            <dt className="text-[10px] tracking-wide text-muted-foreground uppercase">
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
