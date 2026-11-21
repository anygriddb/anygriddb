import {
  DEFAULT_HISTOGRAM_BINS,
  MAX_CHART_CATEGORIES,
  MAX_HISTOGRAM_BINS,
  WIDGET_SIZES,
} from "@anygriddb/core";
import {
  Button,
  cn,
  Dialog,
  DialogContent,
  DragHandle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  Label,
  Select,
  Spinner,
} from "@anygriddb/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  BarChart3,
  History,
  LayoutDashboard,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { Link } from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useNarrowScreen } from "../../lib/narrow-screen";
import { useCatalog } from "../../lib/session";
import { LoadFailed } from "../shell/load-failed";
import { BlockedSourcesBanner } from "../table/source-reach";
import { trpc, useTRPC } from "../../lib/trpc";
import { canManage } from "../../lib/types";
import { PromptDialog } from "../shell/dialogs";
import { Earlier } from "../history/earlier";
import {
  moveWidget,
  placeWidget,
  readingOrder,
  widgetCell,
} from "./widget-layout";
import { canGroupBy } from "../table/field-roles";
import { ViewWidget } from "./view-widget";
import {
  categoriesAsked,
  embeddedViewId,
  fieldKept,
  fieldShown,
  groupChoices,
  lastValueText,
  measurableFields,
  measureAddsUp,
  measuredColumn,
  measureShown,
  orderingFields,
} from "./widget-view";
import { groupsDates } from "./span-label";
import { DashboardHistory, type WidgetBody } from "./dashboard-history";
import { useWidgetDrag, useWidgetDrop } from "./widget-drag";
import { useUndo } from "../grid/use-undo";
import { tableTakesUndo, undoShortcut } from "../../lib/keyboard-undo";
import { useLingui } from "@lingui/react/macro";
import { AGGREGATE_LABELS } from "../../lib/aggregate-labels";
import { raw } from "../../lib/known-text";
import { reasonOf, useErrorText } from "../../lib/errors";
import {
  formatAggregate,
  formatInstant,
  numberFormatOf,
} from "../../lib/format";
import { useLocale } from "../../lib/i18n";
import { useTableChanges } from "../../lib/realtime";
// ECharts loads with the dashboards only (ADR 0035).
const ChartView = lazy(() =>
  import("./chart-view").then((module) => ({ default: module.ChartView })),
);

const WIDGET_KINDS = ["metric", "chart", "view_embed"] as const;
type WidgetKind = (typeof WIDGET_KINDS)[number];

const CHART_STYLES = [
  "bar",
  "bar_horizontal",
  "line",
  "area",
  "pie",
  "histogram",
] as const;
type ChartStyle = (typeof CHART_STYLES)[number];

type WidgetModel = {
  id: string;
  kind: string;
  title: string;
  x: number;
  y: number;
  w: number;
  h: number;
  config: Record<string, unknown>;
};

type WidgetDraft = {
  title: string;
  kind: WidgetKind;
  config: Record<string, unknown>;
};

type OpenForm = { mode: "add" } | { mode: "edit"; widget: WidgetModel };

function isWidgetKind(value: string): value is WidgetKind {
  return WIDGET_KINDS.some((kind) => kind === value);
}

/** The measures the form offers; another, set elsewhere, is listed too. */
const OFFERED_MEASURES = new Set([
  "count_all",
  "count_filled",
  "sum",
  "avg",
  "min",
  "max",
  "last",
]);

function isChartStyle(value: string): value is ChartStyle {
  return CHART_STYLES.some((style) => style === value);
}

function configString(config: Record<string, unknown>, key: string): string {
  const value = config[key];
  return typeof value === "string" ? value : "";
}

function bodyOf(widget: WidgetModel): WidgetBody {
  if (!isWidgetKind(widget.kind)) throw new Error("Internal error");
  return {
    title: widget.title,
    kind: widget.kind,
    x: widget.x,
    y: widget.y,
    w: widget.w,
    h: widget.h,
    config: widget.config,
  };
}

function placeOf(widget: WidgetModel) {
  return {
    id: widget.id,
    x: widget.x,
    y: widget.y,
    w: widget.w,
    h: widget.h,
  };
}

export function DashboardBoard(props: { baseId: string; dashboardId: string }) {
  return <DashboardEditor key={props.dashboardId} {...props} />;
}

function DashboardEditor(props: { baseId: string; dashboardId: string }) {
  const { t, i18n } = useLingui();
  const api = useTRPC();
  // A phone has no room for twelve columns: its widgets stand in one.
  const narrow = useNarrowScreen();
  const queryClient = useQueryClient();
  const catalog = useCatalog();
  const base = catalog.data?.find((item) => item.id === props.baseId);
  const manage = canManage(base?.role);
  const board = useQuery(
    api.dashboards.get.queryOptions({ dashboardId: props.dashboardId }),
  );
  const errorText = useErrorText();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<OpenForm | null>(null);
  // After a version was put back from the trail: the dashboard, the list
  // of dashboards (its name), and the widget's own figures.
  async function reread(widgetId?: string) {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: api.dashboards.get.queryKey({
          dashboardId: props.dashboardId,
        }),
      }),
      queryClient.invalidateQueries({
        queryKey: api.dashboards.list.queryKey({ baseId: props.baseId }),
      }),
      ...(widgetId
        ? [
            queryClient.invalidateQueries({
              queryKey: api.dashboards.widgetData.queryKey({
                dashboardId: props.dashboardId,
                widgetId,
              }),
            }),
          ]
        : []),
    ]);
  }
  const [renaming, setRenaming] = useState(false);
  const undo = useUndo({ keepFailed: true });
  const [history] = useState(() => new DashboardHistory(undo));
  const undoLast = undo.undo;
  const redoLast = undo.redo;

  useEffect(() => {
    const refresh = async () => {
      await queryClient.invalidateQueries({
        queryKey: api.dashboards.get.queryKey({
          dashboardId: props.dashboardId,
        }),
      });
    };
    history.setWrites({
      create: async (body) => {
        const created = await trpc.dashboards.upsertWidget.mutate({
          dashboardId: props.dashboardId,
          title: body.title,
          kind: body.kind,
          x: body.x,
          y: body.y,
          w: body.w,
          h: body.h,
          config: body.config,
        });
        await refresh();
        return { id: created.id };
      },
      update: async (id, body) => {
        await trpc.dashboards.upsertWidget.mutate({
          dashboardId: props.dashboardId,
          widgetId: id,
          title: body.title,
          kind: body.kind,
          x: body.x,
          y: body.y,
          w: body.w,
          h: body.h,
          config: body.config,
        });
        await Promise.all([
          refresh(),
          queryClient.invalidateQueries({
            queryKey: api.dashboards.widgetData.queryKey({
              dashboardId: props.dashboardId,
              widgetId: id,
            }),
          }),
        ]);
      },
      remove: async (id) => {
        await trpc.dashboards.deleteWidget.mutate({
          dashboardId: props.dashboardId,
          widgetId: id,
        });
        await refresh();
      },
      layout: async (widgets) => {
        await trpc.dashboards.layout.mutate({
          dashboardId: props.dashboardId,
          widgets: widgets.map((widget) => ({
            id: widget.id,
            x: widget.x,
            y: widget.y,
            w: widget.w,
            h: widget.h,
          })),
        });
        await refresh();
      },
      rename: async (name) => {
        await trpc.dashboards.update.mutate({
          dashboardId: props.dashboardId,
          name,
        });
        await Promise.all([
          refresh(),
          queryClient.invalidateQueries({
            queryKey: api.dashboards.list.queryKey({ baseId: props.baseId }),
          }),
        ]);
      },
    });
  }, [api, history, props.baseId, props.dashboardId, queryClient]);

  // Ctrl Z and Ctrl Y (or Ctrl Shift Z) undo this dashboard's changes,
  // as the Undo button beside Edit does once editing is done. Text being
  // typed, and a dialog, keep their own.
  useEffect(() => {
    if (!manage) return;
    const onKey = (event: KeyboardEvent) => {
      const action = undoShortcut(event);
      if (!action || !event.isTrusted || event.defaultPrevented) return;
      const target = event.target instanceof Element ? event.target : null;
      if (!tableTakesUndo(target)) return;
      event.preventDefault();
      const run = action === "undo" ? undoLast : redoLast;
      void run().catch((cause: unknown) => {
        toast.error(errorText(cause));
      });
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [manage, undoLast, redoLast, errorText]);

  if (!base) return null;
  if (board.isLoading) {
    return (
      <div className="flex h-40 items-center justify-center">
        <Spinner />
      </div>
    );
  }
  // A dashboard that is not there, or no longer: said so, where trying
  // again could only be refused again.
  if (
    !board.data &&
    (!board.isError || reasonOf(board.error).code === "unknown_dashboard")
  ) {
    return (
      <p className="p-6 text-sm text-muted-foreground">
        {t`This dashboard does not exist.`}
      </p>
    );
  }
  if (board.isError) {
    return (
      <LoadFailed error={board.error} onRetry={() => void board.refetch()} />
    );
  }

  const { dashboard, widgets } = board.data;
  const widgetTables = widgets.flatMap((widget) => {
    const tableId = configString(widget.config, "tableId");
    const table = base.tables.find((item) => item.id === tableId);
    return table ? [table] : [];
  });
  let oldestCopy: number | null = null;
  for (const table of widgetTables) {
    const at = table.external?.synced?.at;
    if (!at) continue;
    const time = new Date(at).getTime();
    if (oldestCopy === null || time < oldestCopy) oldestCopy = time;
  }
  const ordered = readingOrder(widgets);
  const modifying = manage && editing;
  const boardLocale = i18n.locale === "fr" ? "fr" : "en";

  function fail(cause: unknown) {
    toast.error(errorText(cause));
  }

  async function run(action: () => Promise<void>) {
    try {
      await action();
    } catch (cause) {
      fail(cause);
    }
  }

  async function commitLayout(layout: readonly WidgetModel[]) {
    await history.move(widgets.map(placeOf), layout.map(placeOf), t`Move`);
  }

  async function saveWidget(draft: WidgetDraft) {
    const title = draft.title.trim();
    if (form?.mode === "edit") {
      const before = bodyOf(form.widget);
      const after: WidgetBody = {
        ...before,
        title,
        kind: draft.kind,
        config: draft.config,
      };
      await history.edit(form.widget.id, before, after, t`Edit`);
      return;
    }
    await history.add(
      {
        title,
        kind: draft.kind,
        x: 0,
        y:
          widgets.length === 0
            ? 0
            : Math.max(...widgets.map((widget) => widget.y + widget.h)),
        ...WIDGET_SIZES[draft.kind],
        config: draft.config,
      },
      t`Add`,
    );
  }

  async function removeWidget(widget: WidgetModel) {
    await history.remove(widget.id, bodyOf(widget), t`Delete`);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-6">
      <BlockedSourcesBanner
        tables={widgetTables}
        locale={boardLocale}
        surface="dashboard"
      />
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
        {/* Wide enough to be read: on a narrow screen what follows goes
            to the next line, where the name was cut to two letters. */}
        <div className="min-w-40 flex-1">
          <h1 className="truncate text-xl font-semibold">{dashboard.name}</h1>
          {oldestCopy !== null ? (
            <p role="note" className="text-xs text-muted-foreground">
              {t`Figures follow the copy of ${{
                date: formatInstant(oldestCopy, i18n.locale),
              }}`}
            </p>
          ) : null}
        </div>
        {manage && !modifying ? (
          <>
            {undo.canUndo || undo.canRedo ? (
              <UndoRedo
                canUndo={undo.canUndo}
                canRedo={undo.canRedo}
                onUndo={() => void undoLast().catch(fail)}
                onRedo={() => void redoLast().catch(fail)}
              />
            ) : null}
            <Button
              size="sm"
              variant="outline"
              onClick={() => setEditing(true)}
            >
              <Pencil className="h-4 w-4" aria-hidden />
              {t`Edit`}
            </Button>
          </>
        ) : null}
      </div>
      {modifying ? (
        <div className="flex flex-wrap items-center gap-2 rounded-sm bg-muted px-3 py-2">
          <p className="text-sm font-medium" role="status">
            {t`Editing`}
          </p>
          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
            <UndoRedo
              canUndo={undo.canUndo}
              canRedo={undo.canRedo}
              onUndo={() => void undoLast().catch(fail)}
              onRedo={() => void redoLast().catch(fail)}
            />
            <Button size="sm" variant="ghost" onClick={() => setRenaming(true)}>
              {t`Rename the dashboard`}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setForm({ mode: "add" })}
            >
              <Plus className="h-4 w-4" aria-hidden />
              {t`Add a widget`}
            </Button>
            <Button
              size="sm"
              onClick={() => {
                setEditing(false);
                setForm(null);
              }}
            >
              {t`Done editing`}
            </Button>
          </div>
        </div>
      ) : null}
      <div
        className="grid gap-3"
        style={{
          gridTemplateColumns: "repeat(12, minmax(0, 1fr))",
          gridAutoRows: "4.5rem",
        }}
      >
        {ordered.map((widget, index) => (
          <WidgetCard
            key={widget.id}
            baseId={props.baseId}
            dashboardId={props.dashboardId}
            widget={widget}
            stacked={narrow}
            editing={modifying}
            first={index === 0}
            last={index === ordered.length - 1}
            onMove={(by) => {
              const layout = moveWidget(widgets, widget.id, by);
              if (!layout) return;
              void run(() => commitLayout(layout));
            }}
            onEdit={() => setForm({ mode: "edit", widget })}
            onReverted={() => void reread(widget.id)}
            onDelete={() => void run(() => removeWidget(widget))}
            onDropWidget={(draggedId) => {
              const layout = placeWidget(widgets, draggedId, index);
              if (!layout) return;
              void run(() => commitLayout(layout));
            }}
          />
        ))}
      </div>
      {widgets.length === 0 ? (
        <p className="rounded-sm border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
          {t`Add a metric, a chart, or a view.`}
        </p>
      ) : null}
      <Dialog
        open={form !== null}
        onOpenChange={(open) => {
          if (!open) setForm(null);
        }}
      >
        <DialogContent
          title={form?.mode === "edit" ? t`Edit the widget` : t`Add a widget`}
          wide
          fullOnPhone
        >
          {form ? (
            <WidgetForm
              key={form.mode === "edit" ? form.widget.id : "add"}
              baseId={props.baseId}
              mode={form.mode}
              initial={
                form.mode === "edit"
                  ? {
                      title: form.widget.title,
                      kind: isWidgetKind(form.widget.kind)
                        ? form.widget.kind
                        : "metric",
                      config: form.widget.config,
                    }
                  : null
              }
              onSubmit={async (draft) => {
                await saveWidget(draft);
                setForm(null);
              }}
            />
          ) : null}
        </DialogContent>
      </Dialog>
      <PromptDialog
        open={renaming}
        onOpenChange={setRenaming}
        title={t`Rename the dashboard`}
        label={t`Name`}
        initial={dashboard.name}
        submitLabel={t`Rename`}
        onSubmit={async (name) => {
          try {
            await history.rename(dashboard.name, name.trim(), t`Rename`);
          } catch (cause) {
            fail(cause);
          }
        }}
      >
        <Earlier
          kind="dashboard"
          id={props.dashboardId}
          seen={() => ({
            name: dashboard.name,
            description: dashboard.description,
          })}
          onReverted={() => void reread()}
        />
      </PromptDialog>
    </div>
  );
}

function UndoRedo(props: {
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
}) {
  const { t } = useLingui();
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        disabled={!props.canUndo}
        onClick={props.onUndo}
      >
        {t`Undo`}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={!props.canRedo}
        onClick={props.onRedo}
      >
        {t`Redo`}
      </Button>
    </>
  );
}

function WidgetCard(props: {
  baseId: string;
  dashboardId: string;
  editing: boolean;
  /** The first or last in reading order: it moves no further that way. */
  first: boolean;
  last: boolean;
  onMove: (by: -1 | 1) => void;
  onEdit: () => void;
  /** An earlier version was put back from the trail (ADR 0089). */
  onReverted: () => void;
  onDelete: () => void;
  onDropWidget: (draggedId: string) => void;
  widget: WidgetModel;
  /** On a narrow screen: under the widget before it, the page's width. */
  stacked: boolean;
}) {
  const { t } = useLingui();
  const errorText = useErrorText();
  const api = useTRPC();
  const [earlier, setEarlier] = useState(false);
  const { locale } = useLocale();
  const catalog = useCatalog();
  // A sum or a mean is written as its field is: euros stay euros.
  const measured = measuredColumn(
    catalog.data?.find((item) => item.id === props.baseId)?.tables,
    props.widget.config,
  );
  const data = useQuery(
    api.dashboards.widgetData.queryOptions({
      dashboardId: props.dashboardId,
      widgetId: props.widget.id,
    }),
  );
  // A figure and a chart follow their table: once its rows change, they
  // are read again. A view's widget reads its own rows, and follows them.
  useTableChanges(
    props.widget.kind === "view_embed"
      ? undefined
      : configString(props.widget.config, "tableId") || undefined,
    () => void data.refetch(),
  );
  const name = props.widget.title;
  const { dragProps, dragButtonProps, isDragging } = useWidgetDrag(
    props.widget.id,
    name,
    props.editing,
  );
  const ref = useRef<HTMLElement>(null);
  const { dropProps, isDropTarget } = useWidgetDrop(
    ref,
    props.widget.id,
    props.onDropWidget,
    props.editing,
  );

  return (
    <>
      <article
        ref={ref}
        {...dropProps}
        // While widgets are arranged, each is a place to drop another,
        // reached with Tab: it takes the keyboard and says its name.
        {...(props.editing ? { "aria-label": name, tabIndex: -1 } : {})}
        className={cn(
          "flex min-h-0 flex-col overflow-hidden rounded-sm border bg-card focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring",
          props.editing
            ? "border-dashed border-strong-border"
            : "border-border",
          isDropTarget && "ring-2 ring-primary",
          isDragging && "opacity-50",
        )}
        style={widgetCell(props.widget, props.stacked)}
      >
        <header
          className="flex items-center gap-2 border-b border-border px-3 py-2"
          {...(props.editing ? dragProps : {})}
        >
          {props.editing ? (
            <DragHandle {...dragButtonProps} label={t`Move ${name}`} />
          ) : null}
          <BarChart3
            className="h-3.5 w-3.5 text-muted-foreground"
            aria-hidden
          />
          <h2 className="min-w-0 flex-1 truncate text-sm font-medium">
            {name}
          </h2>
          {props.editing ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7"
                  aria-label={t`Actions for ${{ widget: name }}`}
                >
                  <MoreHorizontal className="h-3.5 w-3.5" aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={props.onEdit}>
                  <Pencil className="h-4 w-4" aria-hidden />
                  {t`Edit`}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setEarlier(true)}>
                  <History className="h-4 w-4" aria-hidden />
                  {t`Earlier`}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={props.first}
                  onSelect={() => props.onMove(-1)}
                >
                  <ArrowUp className="h-4 w-4" aria-hidden />
                  {t`Move earlier`}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={props.last}
                  onSelect={() => props.onMove(1)}
                >
                  <ArrowDown className="h-4 w-4" aria-hidden />
                  {t`Move later`}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem danger onSelect={props.onDelete}>
                  <Trash2 className="h-4 w-4" aria-hidden />
                  {t`Delete`}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </header>
        <div className="min-h-0 flex-1 p-3">
          {data.isLoading ? (
            <div className="flex h-full items-center justify-center">
              <Spinner />
            </div>
          ) : data.data?.kind === "metric" ? (
            <p className="flex h-full items-center justify-center text-3xl font-semibold tabular-nums">
              {data.data.fn === "last"
                ? lastValueText(data.data.value, measured, locale)
                : formatAggregate(
                    data.data.value,
                    data.data.fn,
                    measured,
                    locale,
                    2,
                  )}
            </p>
          ) : data.data?.kind === "chart" ? (
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center">
                  <Spinner />
                </div>
              }
            >
              <ChartView
                data={data.data}
                title={name}
                numberFormat={numberFormatOf(measured)}
              />
            </Suspense>
          ) : data.data?.kind === "view_embed" ? (
            <ViewWidget
              baseId={props.baseId}
              tableId={data.data.tableId}
              viewId={data.data.viewId}
              title={name}
            />
          ) : (
            <p className="text-sm text-danger">{errorText(data.error)}</p>
          )}
        </div>
      </article>
      {earlier ? (
        <Dialog open onOpenChange={setEarlier}>
          <DialogContent title={t`Earlier`}>
            <Earlier
              kind="widget"
              id={props.widget.id}
              seen={() => ({
                title: props.widget.title,
                kind: props.widget.kind,
                config: props.widget.config,
              })}
              onReverted={props.onReverted}
            />
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}

function WidgetForm(props: {
  baseId: string;
  mode: "add" | "edit";
  initial: WidgetDraft | null;
  onSubmit: (draft: WidgetDraft) => Promise<void>;
}) {
  const { t } = useLingui();
  const errorText = useErrorText();
  const catalog = useCatalog();
  const base = catalog.data?.find((item) => item.id === props.baseId);
  const api = useTRPC();
  const tables = base?.tables ?? [];
  const config = props.initial?.config ?? {};
  const [kind, setKind] = useState<WidgetKind>(props.initial?.kind ?? "metric");
  const [title, setTitle] = useState(props.initial?.title ?? "");
  const [tableId, setTableId] = useState(
    configString(config, "tableId") || tables[0]?.id || "",
  );
  const table = tables.find((item) => item.id === tableId);
  const columns = table?.columns ?? [];
  const viewsQuery = useQuery({
    ...api.catalog.views.queryOptions({ tableId }),
    enabled: Boolean(tableId),
  });
  const views = viewsQuery.data?.views ?? [];
  const groupable = columns.filter((column) =>
    ["single_select", "multi_select", "user", "boolean", "text"].includes(
      column.fieldType,
    ),
  );
  // What a histogram bins: a field that reads as a number. A duration is
  // left out: its bounds would be read as seconds.
  const binnable = columns.filter(
    (item) => item.kind === "number" && item.fieldType !== "duration",
  );
  // What was chosen in each list. A list shows a field as chosen whatever
  // this holds (its first, once the table or the measure has changed):
  // the form reads and saves the one each list shows, worked out below.
  const [column, setColumn] = useState(configString(config, "column"));
  const [binned, setBinned] = useState(configString(config, "column"));
  const storedBins = config.bins;
  const [bins, setBins] = useState(
    typeof storedBins === "number"
      ? String(storedBins)
      : String(DEFAULT_HISTOGRAM_BINS),
  );
  const [groupBy, setGroupBy] = useState(configString(config, "groupBy"));
  const [viewId, setViewId] = useState(configString(config, "viewId"));
  const storedStyle = configString(config, "chartType");
  const [chartType, setChartType] = useState<ChartStyle>(
    isChartStyle(storedStyle) ? storedStyle : "bar",
  );
  const [seriesBy, setSeriesBy] = useState(configString(config, "seriesBy"));
  const [fn, setFn] = useState(configString(config, "fn") || "count_all");
  const [orderBy, setOrderBy] = useState(configString(config, "orderBy"));
  const [byValue, setByValue] = useState(config.order === "value");
  const [shown, setShown] = useState(
    typeof config.limit === "number" ? String(config.limit) : "",
  );
  const [sideBySide, setSideBySide] = useState(config.sideBySide === true);
  const [period, setPeriod] = useState(configString(config, "period") || "day");
  // The measure its list shows, the fields it can read, and the one
  // their list shows.
  const measure = measureShown(kind, fn);
  const measurable = measurableFields(columns, measure);
  const measured = fieldShown(measurable, column);
  // A last value is the last by a field that puts the rows in order.
  const byLast = kind === "metric" && measure === "last";
  const ordering = orderingFields(columns);
  const orderedBy = fieldShown(ordering, orderBy);
  const binField = fieldShown(binnable, binned);
  // A chart groups by a field people group by, before any other.
  const groupFields = groupChoices(columns, groupBy);
  const grouped = fieldShown(
    [...groupable.filter(canGroupBy), ...groupFields],
    groupBy,
  );
  const seriesFields = groupChoices(columns, seriesBy).filter(
    (item) => item.name !== grouped,
  );
  const series = fieldKept(seriesFields, seriesBy);
  // A field saved before the server refused it stays shown, and is changed
  // before the chart is saved again: it could not be drawn.
  const groupsBy = (name: string) =>
    columns.some((item) => item.name === name && canGroupBy(item));
  const chartGroups = groupsBy(grouped) && (!series || groupsBy(series));
  // A measure that reads a field, on a table that has none it can read.
  const nothingToMeasure = measure !== "count_all" && measurable.length === 0;
  // Dates are grouped by day, or by more: a week, a month, a quarter, a year.
  const dated = groupsDates(
    columns.find((item) => item.name === grouped)?.fieldType,
  );
  const most = String(MAX_CHART_CATEGORIES);
  // Shares are each of the whole, largest first: nothing to choose there.
  const ordered = chartType !== "pie" && chartType !== "histogram";
  // Series that add up stand one on another, or side by side.
  const stackable = ordered && Boolean(series) && measureAddsUp(measure);
  const [busy, setBusy] = useState(false);

  const embedded = embeddedViewId(views, viewId);

  async function submit() {
    if (!title.trim() || !tableId) return;
    if (kind === "view_embed" && !embedded) {
      toast.error(t`Invalid view`);
      return;
    }
    setBusy(true);
    try {
      const draftConfig =
        kind === "metric"
          ? {
              tableId,
              // A figure names a field even when it counts rows.
              column: measured || fieldShown(columns, column),
              fn: measure,
              ...(byLast ? { orderBy: orderedBy } : {}),
              ...(viewId ? { viewId } : {}),
            }
          : kind === "chart"
            ? chartType === "histogram"
              ? {
                  tableId,
                  chartType,
                  column: binField,
                  bins: Number(bins),
                  ...(viewId ? { viewId } : {}),
                }
              : {
                  tableId,
                  groupBy: grouped,
                  chartType,
                  fn: measure,
                  // Counting rows needs no field; any other measure reads one.
                  ...(measure === "count_all" ? {} : { column: measured }),
                  ...(series ? { seriesBy: series } : {}),
                  ...(dated && period !== "day" ? { period } : {}),
                  ...(ordered && byValue ? { order: "value" } : {}),
                  ...(ordered &&
                  categoriesAsked(shown, MAX_CHART_CATEGORIES) !== null
                    ? { limit: categoriesAsked(shown, MAX_CHART_CATEGORIES) }
                    : {}),
                  ...(stackable && sideBySide ? { sideBySide: true } : {}),
                  ...(viewId ? { viewId } : {}),
                }
            : { tableId, viewId: embedded };
      await props.onSubmit({ title: title.trim(), kind, config: draftConfig });
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  // What a figure and a chart measure: asked the same way of both.
  const measureFields = (
    <>
      <div className="flex flex-col gap-1">
        <Label htmlFor="widget-measure">{t`Measure`}</Label>
        <Select
          id="widget-measure"
          value={measure}
          onChange={(event) => setFn(event.target.value)}
        >
          <option value="count_all">{t`Row count`}</option>
          <option value="count_filled">{t`Filled`}</option>
          <option value="sum">{t`Sum`}</option>
          <option value="avg">{t`Average`}</option>
          <option value="min">{t`Min`}</option>
          <option value="max">{t`Max`}</option>
          {/* A figure's alone: a chart has no last value. */}
          {kind === "metric" ? (
            <option value="last">{t`Last value`}</option>
          ) : null}
          {/* A measure set outside this form is kept, by its name. */}
          {OFFERED_MEASURES.has(measure) ? null : (
            <option value={measure}>
              {t(AGGREGATE_LABELS[measure] ?? raw(measure))}
            </option>
          )}
        </Select>
      </div>
      {measure !== "count_all" ? (
        <div className="flex flex-col gap-1">
          <Label htmlFor="widget-measured">{t`Measured field`}</Label>
          <Select
            id="widget-measured"
            value={measured}
            aria-describedby={
              nothingToMeasure ? "widget-measured-hint" : undefined
            }
            onChange={(event) => setColumn(event.target.value)}
          >
            {measurable.map((item) => (
              <option key={item.name} value={item.name}>
                {item.label}
              </option>
            ))}
          </Select>
          {nothingToMeasure ? (
            <p
              id="widget-measured-hint"
              className="text-xs text-muted-foreground"
            >
              {t`This table has no field this measure can read.`}
            </p>
          ) : null}
        </div>
      ) : null}
      {byLast ? (
        <div className="flex flex-col gap-1 sm:col-span-2">
          <Label htmlFor="widget-order">{t`Rows ordered by`}</Label>
          <Select
            id="widget-order"
            value={orderedBy}
            aria-describedby="widget-order-hint"
            onChange={(event) => setOrderBy(event.target.value)}
          >
            {ordering.map((item) => (
              <option key={item.name} value={item.name}>
                {item.label}
              </option>
            ))}
          </Select>
          <p id="widget-order-hint" className="text-xs text-muted-foreground">
            {ordering.length === 0
              ? t`This table has no date or number field to put its rows in order.`
              : t`The last row is the one where this field is greatest and, of several, the one added last. A row where either field is empty is passed over.`}
          </p>
        </div>
      ) : null}
    </>
  );

  return (
    <form
      className="grid gap-3 sm:grid-cols-2"
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
        <Label htmlFor="widget-kind">{t`Type`}</Label>
        <Select
          id="widget-kind"
          value={kind}
          onChange={(event) => {
            const value = event.target.value;
            if (isWidgetKind(value)) setKind(value);
          }}
        >
          <option value="metric">{t`Metric`}</option>
          <option value="chart">{t`Chart`}</option>
          <option value="view_embed">{t`Embedded view`}</option>
        </Select>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="widget-table">{t`Table`}</Label>
        <Select
          id="widget-table"
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
          <Label htmlFor="widget-view">{t`View (optional filter)`}</Label>
          <Select
            id="widget-view"
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
          <Label htmlFor="widget-view">{t`View`}</Label>
          <Select
            id="widget-view"
            value={embedded}
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
      {kind === "metric" ? measureFields : null}
      {kind === "chart" ? (
        <>
          <div className="flex flex-col gap-1">
            <Label htmlFor="chart-style">{t`Style`}</Label>
            <Select
              id="chart-style"
              value={chartType}
              onChange={(event) => {
                const value = event.target.value;
                if (isChartStyle(value)) setChartType(value);
              }}
            >
              <option value="bar">{t`Columns`}</option>
              <option value="bar_horizontal">{t`Horizontal bars`}</option>
              <option value="line">{t`Line`}</option>
              <option value="area">{t`Area`}</option>
              <option value="pie">{t`Shares of the total`}</option>
              <option value="histogram">{t`Histogram`}</option>
            </Select>
          </div>
          {chartType === "histogram" ? (
            <>
              <div className="flex flex-col gap-1">
                <Label htmlFor="chart-binned">{t`Number field`}</Label>
                <Select
                  id="chart-binned"
                  value={binField}
                  aria-describedby="chart-binned-hint"
                  onChange={(event) => setBinned(event.target.value)}
                >
                  {binnable.map((item) => (
                    <option key={item.name} value={item.name}>
                      {item.label}
                    </option>
                  ))}
                </Select>
                <p
                  id="chart-binned-hint"
                  className="text-xs text-muted-foreground"
                >
                  {binnable.length === 0
                    ? t`This table has no number field to count in bins.`
                    : t`Its rows are counted in equal bins, from the least value to the greatest.`}
                </p>
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="chart-bins">{t`Bins`}</Label>
                <Input
                  id="chart-bins"
                  type="number"
                  inputMode="numeric"
                  min={2}
                  max={MAX_HISTOGRAM_BINS}
                  step={1}
                  required
                  value={bins}
                  onChange={(event) => setBins(event.target.value)}
                />
              </div>
            </>
          ) : (
            <>
              {measureFields}
              <div className="flex flex-col gap-1">
                <Label htmlFor="chart-group">{t`Group by`}</Label>
                <Select
                  id="chart-group"
                  value={grouped}
                  onChange={(event) => setGroupBy(event.target.value)}
                >
                  {groupFields.map((item) => (
                    <option key={item.name} value={item.name}>
                      {item.label}
                    </option>
                  ))}
                </Select>
              </div>
              {dated ? (
                <div className="flex flex-col gap-1">
                  <Label htmlFor="chart-period">{t`Dates grouped by`}</Label>
                  <Select
                    id="chart-period"
                    value={period}
                    onChange={(event) => setPeriod(event.target.value)}
                  >
                    <option value="day">{t`Day`}</option>
                    <option value="week">{t`Week`}</option>
                    <option value="month">{t`Month`}</option>
                    <option value="quarter">{t`Quarter`}</option>
                    <option value="year">{t`Year`}</option>
                  </Select>
                </div>
              ) : null}
              <div className="flex flex-col gap-1">
                <Label htmlFor="chart-series">{t`Series (optional)`}</Label>
                <Select
                  id="chart-series"
                  value={series}
                  onChange={(event) => setSeriesBy(event.target.value)}
                >
                  <option value="">{t`None`}</option>
                  {seriesFields.map((item) => (
                    <option key={item.name} value={item.name}>
                      {item.label}
                    </option>
                  ))}
                </Select>
              </div>
              {stackable ? (
                <div className="flex flex-col gap-1">
                  <Label htmlFor="chart-stack">{t`Series are drawn`}</Label>
                  <Select
                    id="chart-stack"
                    value={sideBySide ? "beside" : "stacked"}
                    onChange={(event) =>
                      setSideBySide(event.target.value === "beside")
                    }
                  >
                    <option value="stacked">{t`One on another`}</option>
                    <option value="beside">{t`Side by side`}</option>
                  </Select>
                </div>
              ) : null}
              {ordered ? (
                <>
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="chart-order">{t`Order`}</Label>
                    <Select
                      id="chart-order"
                      value={byValue ? "value" : "field"}
                      onChange={(event) =>
                        setByValue(event.target.value === "value")
                      }
                    >
                      <option value="field">{t`As the field orders them`}</option>
                      <option value="value">{t`Largest value first`}</option>
                    </Select>
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label htmlFor="chart-shown">{t`Categories shown`}</Label>
                    <Input
                      id="chart-shown"
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={MAX_CHART_CATEGORIES}
                      step={1}
                      placeholder={most}
                      aria-describedby="chart-shown-hint"
                      value={shown}
                      onChange={(event) => setShown(event.target.value)}
                    />
                    <p
                      id="chart-shown-hint"
                      className="text-xs text-muted-foreground"
                    >
                      {t`The first of that order. Empty: up to ${most}.`}
                    </p>
                  </div>
                </>
              ) : null}
            </>
          )}
        </>
      ) : null}
      <div className="flex justify-end gap-2 sm:col-span-2">
        <Button
          type="submit"
          disabled={
            busy ||
            !title.trim() ||
            (kind === "chart" && chartType === "histogram"
              ? binnable.length === 0
              : kind !== "view_embed" &&
                (nothingToMeasure ||
                  (byLast && ordering.length === 0) ||
                  (kind === "chart" && !chartGroups)))
          }
        >
          {busy ? <Spinner /> : null}
          {props.mode === "add" ? t`Add` : t`Save`}
        </Button>
      </div>
    </form>
  );
}
