import { cellText } from "@anygriddb/core";
import { Spinner } from "@anygriddb/ui";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useErrorText } from "../../lib/errors";
import { cellDisplay, formatNumber } from "../../lib/format";
import { useLocale } from "../../lib/i18n";
import { useTableChanges } from "../../lib/realtime";
import { useCatalog } from "../../lib/session";
import { useTRPC } from "../../lib/trpc";
import type { Collaborator, RowItem } from "../../lib/types";
import { CellValueView } from "../fields/cell-value";
import { orderColumns, visibleColumns } from "../table/column-layout";
import { rowsLeftOut, WIDGET_ROWS } from "./widget-view";

const NO_PEOPLE: ReadonlyMap<string, Collaborator> = new Map();

/**
 * A view of a table on a dashboard: its first rows, with the fields the
 * view shows, in its order, under its filter and its sort, as the reader
 * may read them, and read again once the table's rows change. Each row
 * opens in its table, and so does the view.
 */
export function ViewWidget(props: {
  baseId: string;
  tableId: string;
  viewId: string;
  /** The widget's title, which names its table of rows. */
  title: string;
}) {
  const { t } = useLingui();
  const { locale } = useLocale();
  const errorText = useErrorText();
  const api = useTRPC();
  const catalog = useCatalog();
  const table = catalog.data
    ?.find((base) => base.id === props.baseId)
    ?.tables.find((item) => item.id === props.tableId);
  const views = useQuery(
    api.catalog.views.queryOptions({ tableId: props.tableId }),
  );
  const collaborators = useQuery(
    api.catalog.collaborators.queryOptions({ baseId: props.baseId }),
  );
  const read = useQuery(
    api.rows.read.queryOptions({
      tableId: props.tableId,
      viewId: props.viewId,
      limit: WIDGET_ROWS,
      withGroups: "none",
    }),
  );
  // Its table's rows changed: the view's first rows are read again.
  useTableChanges(props.tableId, () => void read.refetch());
  const view = views.data?.views.find((item) => item.id === props.viewId);
  const columns = visibleColumns(
    orderColumns(table?.columns ?? [], view?.config.fieldOrder),
    view?.config.hiddenFields,
  );
  const people = collaborators.data
    ? new Map(collaborators.data.users.map((person) => [person.id, person]))
    : NO_PEOPLE;
  const open = {
    to: "/b/$baseId/t/$tableId/{-$viewId}",
    params: {
      baseId: props.baseId,
      tableId: props.tableId,
      viewId: props.viewId,
    },
  } as const;
  if (read.isLoading || !table) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (read.error) {
    return <p className="text-sm text-danger">{errorText(read.error)}</p>;
  }
  const rows: readonly RowItem[] = read.data?.rows ?? [];
  const leftOut = rowsLeftOut(rows.length, read.data?.total);
  const shown = formatNumber(rows.length, locale);
  const total = formatNumber(read.data?.total ?? rows.length, locale);
  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      {rows.length === 0 ? (
        <p className="flex-1 text-sm text-muted-foreground">
          {t`No rows in this view.`}
        </p>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full text-left text-xs" aria-label={props.title}>
            <thead className="sticky top-0 bg-card">
              <tr>
                {columns.map((column) => (
                  <th
                    key={column.name}
                    scope="col"
                    className="border-b border-rule px-2 py-1 font-medium whitespace-nowrap text-muted-foreground"
                  >
                    {column.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b border-border">
                  {columns.map((column) => {
                    const value = row[column.name as keyof RowItem];
                    return (
                      <td key={column.name} className="max-w-56 px-2 py-1">
                        {column.isPrimary ? (
                          // The row's name opens it, in its table.
                          <Link
                            {...open}
                            search={{ row: row.id }}
                            className="block truncate py-0.5 font-medium text-primary underline"
                          >
                            {cellDisplay(value, column, locale, people) ||
                              `#${cellText(row.ag_seq)}`}
                          </Link>
                        ) : (
                          <span className="flex min-w-0">
                            <CellValueView
                              value={value}
                              column={column}
                              locale={locale}
                              people={people}
                              inColumn={false}
                            />
                          </span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="flex shrink-0 items-center justify-between gap-3 text-xs text-muted-foreground">
        <span>
          {leftOut > 0
            ? t`The first ${shown} of ${total} rows`
            : plural(rows.length, { one: "# row", other: "# rows" })}
        </span>
        <Link {...open} className="py-1 text-primary underline">
          {t`Open view`}
        </Link>
      </p>
    </div>
  );
}
