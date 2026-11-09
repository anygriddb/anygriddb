import { cellText, isDecimalString } from "@anygriddb/core";

import { Button, Input, Label, Select, Spinner } from "@anygriddb/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  BarChart3,
  LayoutDashboard,
  Plus,
  Trash2,
} from "lucide-react";
import { Link } from "@tanstack/react-router";
import { lazy, Suspense, useState } from "react";
import { toast } from "sonner";
import { useCatalog } from "../../lib/session";
import { trpc, useTRPC } from "../../lib/trpc";
import { canManage } from "../../lib/types";
// ECharts loads with the dashboards only (ADR 0035).
const ChartView = lazy(() =>
  import("./chart-view").then((module) => ({ default: module.ChartView })),
);
import { useLingui } from "@lingui/react/macro";
import { useErrorText } from "../../lib/errors";

type ChartStyle = "bar" | "bar_horizontal" | "line" | "area" | "pie";

type WidgetKind = "metric" | "chart" | "view_embed";

export function DashboardBoard(props: { baseId: string; dashboardId: string }) {
  const { t } = useLingui();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const catalog = useCatalog();
  const base = catalog.data?.find((item) => item.id === props.baseId);
  const manage = canManage(base?.role);
  const board = useQuery(
    api.dashboards.get.queryOptions({ dashboardId: props.dashboardId }),
  );
  const [adding, setAdding] = useState(false);

  if (!base) return null;
  if (board.isLoading) {
    return (
      <div className="flex h-40 items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (!board.data) {
    return (
      <p className="p-6 text-sm text-muted-foreground">
        {t`Dashboard not found`}
      </p>
    );
  }

  const { dashboard, widgets } = board.data;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 p-6">
      <div className="flex flex-wrap items-center gap-3">
        <Button asChild size="icon" variant="ghost">
          <Link
            to="/b/$baseId/dashboards"
            params={{ baseId: props.baseId }}
            aria-label={t`Back`}
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <LayoutDashboard className="h-5 w-5 text-primary" aria-hidden />
        <h1 className="min-w-0 flex-1 truncate text-xl font-semibold">
          {dashboard.name}
        </h1>
        {manage ? (
          <Button size="sm" onClick={() => setAdding((value) => !value)}>
            <Plus className="h-4 w-4" aria-hidden />
            {t`Add a widget`}
          </Button>
        ) : null}
      </div>
      {adding && manage ? (
        <AddWidgetForm
          baseId={props.baseId}
          dashboardId={props.dashboardId}
          nextY={
            widgets.length === 0
              ? 0
              : Math.max(...widgets.map((widget) => widget.y + widget.h))
          }
          onDone={async () => {
            setAdding(false);
            await queryClient.invalidateQueries({
              queryKey: api.dashboards.get.queryKey({
                dashboardId: props.dashboardId,
              }),
            });
          }}
        />
      ) : null}
      <div
        className="grid gap-3"
        style={{
          gridTemplateColumns: "repeat(12, minmax(0, 1fr))",
          gridAutoRows: "4.5rem",
        }}
      >
        {widgets.map((widget) => (
          <WidgetCard
            key={widget.id}
            baseId={props.baseId}
            dashboardId={props.dashboardId}
            widget={widget}
            manage={manage}
            onChanged={() =>
              queryClient.invalidateQueries({
                queryKey: api.dashboards.get.queryKey({
                  dashboardId: props.dashboardId,
                }),
              })
            }
          />
        ))}
      </div>
      {widgets.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
          {t`Add a metric, a chart, or a view.`}
        </p>
      ) : null}
    </div>
  );
}

function WidgetCard(props: {
  baseId: string;
  dashboardId: string;
  manage: boolean;
  widget: {
    id: string;
    kind: string;
    title: string;
    x: number;
    y: number;
    w: number;
    h: number;
    config: Record<string, unknown>;
  };
  onChanged: () => void;
}) {
  const { t } = useLingui();
  const errorText = useErrorText();
  const api = useTRPC();
  const data = useQuery(
    api.dashboards.widgetData.queryOptions({
      dashboardId: props.dashboardId,
      widgetId: props.widget.id,
    }),
  );

  return (
    <article
      className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-card"
      style={{
        gridColumn: `${props.widget.x + 1} / span ${props.widget.w}`,
        gridRow: `${props.widget.y + 1} / span ${props.widget.h}`,
      }}
    >
      <header className="flex items-center gap-2 border-b border-border px-3 py-2">
        <BarChart3 className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium">
          {props.widget.title}
        </h2>
        {props.manage ? (
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            aria-label={t`Delete`}
            onClick={() => {
              void (async () => {
                try {
                  await trpc.dashboards.deleteWidget.mutate({
                    dashboardId: props.dashboardId,
                    widgetId: props.widget.id,
                  });
                  props.onChanged();
                } catch (cause) {
                  toast.error(errorText(cause));
                }
              })();
            }}
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden />
          </Button>
        ) : null}
      </header>
      <div className="min-h-0 flex-1 p-3">
        {data.isLoading ? (
          <div className="flex h-full items-center justify-center">
            <Spinner />
          </div>
        ) : data.data?.kind === "metric" ? (
          <p className="flex h-full items-center justify-center text-3xl font-semibold tabular-nums">
            {formatValue(data.data.value)}
          </p>
        ) : data.data?.kind === "chart" ? (
          <Suspense
            fallback={
              <div className="flex h-full items-center justify-center">
                <Spinner />
              </div>
            }
          >
            <ChartView data={data.data} title={props.widget.title} />
          </Suspense>
        ) : data.data?.kind === "view_embed" ? (
          <div className="flex h-full flex-col items-start justify-center gap-2 text-sm">
            <p className="text-muted-foreground">
              {t`Embedded view — open it in the table.`}
            </p>
            <Button asChild size="sm" variant="outline">
              <Link
                to="/b/$baseId/t/$tableId/{-$viewId}"
                params={{
                  baseId: props.baseId,
                  tableId: data.data.tableId,
                  viewId: data.data.viewId,
                }}
              >
                {t`Open view`}
              </Link>
            </Button>
          </div>
        ) : (
          <p className="text-sm text-danger">{errorText(data.error)}</p>
        )}
      </div>
    </article>
  );
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "number" || isDecimalString(value)) {
    // A decimal string is formatted exactly, without a float (ADR 0023).
    return new Intl.NumberFormat(undefined, {
      maximumFractionDigits: 2,
    }).format(
      typeof value === "string" ? (value as Intl.StringNumericLiteral) : value,
    );
  }
  return cellText(value);
}

function AddWidgetForm(props: {
  baseId: string;
  dashboardId: string;
  nextY: number;
  onDone: () => Promise<void>;
}) {
  const { t } = useLingui();
  const errorText = useErrorText();
  const catalog = useCatalog();
  const base = catalog.data?.find((item) => item.id === props.baseId);
  const api = useTRPC();
  const tables = base?.tables ?? [];
  const [kind, setKind] = useState<WidgetKind>("metric");
  const [title, setTitle] = useState("");
  const [tableId, setTableId] = useState(tables[0]?.id ?? "");
  const table = tables.find((item) => item.id === tableId);
  const columns = table?.columns ?? [];
  const viewsQuery = useQuery({
    ...api.catalog.views.queryOptions({ tableId }),
    enabled: Boolean(tableId),
  });
  const views = viewsQuery.data?.views ?? [];
  const numeric = columns.filter((column) =>
    ["number", "rating", "duration"].includes(column.fieldType),
  );
  const groupable = columns.filter((column) =>
    ["single_select", "multi_select", "user", "boolean", "text"].includes(
      column.fieldType,
    ),
  );
  const [column, setColumn] = useState(
    numeric[0]?.name ?? columns[0]?.name ?? "",
  );
  const [groupBy, setGroupBy] = useState(
    groupable[0]?.name ?? columns[0]?.name ?? "",
  );
  const [viewId, setViewId] = useState("");
  const [chartType, setChartType] = useState<ChartStyle>("bar");
  const [seriesBy, setSeriesBy] = useState("");
  const [fn, setFn] = useState("count_all");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!title.trim() || !tableId) return;
    if (kind === "view_embed" && !viewId) {
      toast.error(t`Invalid view`);
      return;
    }
    setBusy(true);
    try {
      const config =
        kind === "metric"
          ? { tableId, column, fn, ...(viewId ? { viewId } : {}) }
          : kind === "chart"
            ? {
                tableId,
                groupBy,
                chartType,
                fn,
                // Counting rows needs no field; any other measure reads one.
                ...(fn === "count_all" ? {} : { column }),
                ...(seriesBy ? { seriesBy } : {}),
                ...(viewId ? { viewId } : {}),
              }
            : { tableId, viewId };
      await trpc.dashboards.upsertWidget.mutate({
        dashboardId: props.dashboardId,
        title: title.trim(),
        kind,
        x: 0,
        y: props.nextY,
        w: kind === "metric" ? 3 : 6,
        h: kind === "metric" ? 2 : 4,
        config,
      });
      await props.onDone();
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="grid gap-3 rounded-xl border border-border bg-card p-4 sm:grid-cols-2"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="flex flex-col gap-1 sm:col-span-2">
        <Label htmlFor="widget-title">{t`Title`}</Label>
        <Input
          id="widget-title"
          value={title}
          maxLength={100}
          onChange={(event) => setTitle(event.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label>{t`Type`}</Label>
        <Select
          value={kind}
          onChange={(event) => setKind(event.target.value as WidgetKind)}
        >
          <option value="metric">{t`Metric`}</option>
          <option value="chart">{t`Chart`}</option>
          <option value="view_embed">{t`Embedded view`}</option>
        </Select>
      </div>
      <div className="flex flex-col gap-1">
        <Label>{t`Table`}</Label>
        <Select
          value={tableId}
          onChange={(event) => {
            setTableId(event.target.value);
            setViewId("");
          }}
        >
          {tables.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </Select>
      </div>
      {kind !== "view_embed" ? (
        <div className="flex flex-col gap-1">
          <Label>{t`View (optional filter)`}</Label>
          <Select
            value={viewId}
            onChange={(event) => setViewId(event.target.value)}
          >
            <option value="">{t`Whole table`}</option>
            {views.map((view) => (
              <option key={view.id} value={view.id}>
                {view.name}
              </option>
            ))}
          </Select>
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          <Label>{t`View`}</Label>
          <Select
            value={viewId}
            onChange={(event) => setViewId(event.target.value)}
          >
            {views.map((view) => (
              <option key={view.id} value={view.id}>
                {view.name}
              </option>
            ))}
          </Select>
        </div>
      )}
      {kind === "metric" ? (
        <>
          <div className="flex flex-col gap-1">
            <Label>{t`Field`}</Label>
            <Select
              value={column}
              onChange={(event) => setColumn(event.target.value)}
            >
              {columns.map((item) => (
                <option key={item.name} value={item.name}>
                  {item.label}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <Label>{t`Aggregate`}</Label>
            <Select value={fn} onChange={(event) => setFn(event.target.value)}>
              <option value="count_all">{t`Row count`}</option>
              <option value="count_filled">{t`Filled`}</option>
              <option value="sum">{t`Sum`}</option>
              <option value="avg">{t`Average`}</option>
              <option value="min">Min</option>
              <option value="max">Max</option>
            </Select>
          </div>
        </>
      ) : null}
      {kind === "chart" ? (
        <>
          <div className="flex flex-col gap-1">
            <Label htmlFor="chart-measure">{t`Measure`}</Label>
            <Select
              id="chart-measure"
              value={fn}
              onChange={(event) => setFn(event.target.value)}
            >
              <option value="count_all">{t`Row count`}</option>
              <option value="sum">{t`Sum`}</option>
              <option value="avg">{t`Average`}</option>
              <option value="min">Min</option>
              <option value="max">Max</option>
              <option value="count_filled">{t`Filled`}</option>
            </Select>
          </div>
          {fn !== "count_all" ? (
            <div className="flex flex-col gap-1">
              <Label htmlFor="chart-column">{t`Measured field`}</Label>
              <Select
                id="chart-column"
                value={column}
                onChange={(event) => setColumn(event.target.value)}
              >
                {(fn === "count_filled" ? columns : numeric).map((item) => (
                  <option key={item.name} value={item.name}>
                    {item.label}
                  </option>
                ))}
              </Select>
            </div>
          ) : null}
          <div className="flex flex-col gap-1">
            <Label htmlFor="chart-group">{t`Group by`}</Label>
            <Select
              id="chart-group"
              value={groupBy}
              onChange={(event) => setGroupBy(event.target.value)}
            >
              {columns.map((item) => (
                <option key={item.name} value={item.name}>
                  {item.label}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="chart-series">{t`Series (optional)`}</Label>
            <Select
              id="chart-series"
              value={seriesBy}
              onChange={(event) => setSeriesBy(event.target.value)}
            >
              <option value="">{t`None`}</option>
              {columns
                .filter((item) => item.name !== groupBy)
                .map((item) => (
                  <option key={item.name} value={item.name}>
                    {item.label}
                  </option>
                ))}
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="chart-style">{t`Style`}</Label>
            <Select
              id="chart-style"
              value={chartType}
              onChange={(event) =>
                setChartType(event.target.value as ChartStyle)
              }
            >
              <option value="bar">{t`Columns`}</option>
              <option value="bar_horizontal">{t`Horizontal bars`}</option>
              <option value="line">{t`Line`}</option>
              <option value="area">{t`Area`}</option>
              <option value="pie">{t`Shares of the total`}</option>
            </Select>
          </div>
        </>
      ) : null}
      <div className="flex justify-end gap-2 sm:col-span-2">
        <Button type="submit" disabled={busy || !title.trim()}>
          {busy ? <Spinner /> : null}
          {t`Add`}
        </Button>
      </div>
    </form>
  );
}
