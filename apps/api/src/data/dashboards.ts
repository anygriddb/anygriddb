import {
  type AggregateFn,
  type AggregateItem,
  AppError,
  type Binding,
  buildAggregates,
  buildGroupAggregates,
  buildHistogram,
  cellText,
  type ChartOrder,
  type ChartPeriod,
  type ChartType,
  type CreateDashboardInput,
  dashboardWidgetConfigSchema,
  DEFAULT_HISTOGRAM_BINS,
  decimalToNumber,
  MAX_CHART_CATEGORIES,
  normalizeViewConfig,
  pruneViewConfig,
  type ReadSpec,
  selectOptionNames,
  type UpsertWidgetInput,
} from "@anygriddb/core";
import type { Database, DashboardRow, WidgetRow } from "@anygriddb/db";
import { readerEngine } from "./acl.js";
import { withAudit } from "./audit-context.js";
import { liveColumnNames, liveTable, liveView } from "./live.js";
import { aggregateRows, readTransaction, safeTimeZone } from "./rows.js";
import { applyControlPlaneReadSpec } from "../sources/control-plane-read-filter.js";
import { loadView } from "./views.js";
export async function listDashboards(db: Database, baseId: string) {
  return db
    .selectFrom("dashboards")
    .select(["id", "name", "description", "position", "updatedAt"])
    .where("baseId", "=", baseId)
    .orderBy("position", "asc")
    .orderBy("createdAt", "asc")
    .execute();
}

export async function getDashboard(db: Database, dashboardId: string) {
  const dashboard = await loadDashboard(db, dashboardId);
  const widgets = await db
    .selectFrom("dashboardWidgets")
    .selectAll()
    .where("dashboardId", "=", dashboardId)
    .orderBy("y", "asc")
    .orderBy("x", "asc")
    .execute();
  return { dashboard, widgets };
}

export async function loadDashboard(
  db: Database,
  dashboardId: string,
): Promise<DashboardRow> {
  const row = await db
    .selectFrom("dashboards")
    .selectAll()
    .where("id", "=", dashboardId)
    .executeTakeFirst();
  if (!row) throw new AppError("unknown_dashboard");
  return row;
}

export async function createDashboard(
  db: Database,
  userId: string,
  input: CreateDashboardInput,
) {
  const existing = await db
    .selectFrom("dashboards")
    .select("position")
    .where("baseId", "=", input.baseId)
    .execute();
  const position =
    existing.length === 0
      ? 0
      : Math.max(...existing.map((row) => row.position)) + 1;
  const created = await withAudit(db, { userId, source: "web" }, (tx) =>
    tx
      .insertInto("dashboards")
      .values({
        baseId: input.baseId,
        name: input.name,
        description: input.description,
        position,
      })
      .returningAll()
      .executeTakeFirst(),
  );
  if (!created) throw new Error("Internal error");
  return created;
}

export async function updateDashboard(
  db: Database,
  userId: string,
  input: {
    dashboardId: string;
    name?: string;
    description?: string | null;
  },
  source = "web",
) {
  const updated = await withAudit(db, { userId, source }, (tx) =>
    tx
      .updateTable("dashboards")
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined
          ? { description: input.description }
          : {}),
        updatedAt: new Date(),
      })
      .where("id", "=", input.dashboardId)
      .returningAll()
      .executeTakeFirst(),
  );
  if (!updated) throw new AppError("unknown_dashboard");
  return updated;
}

export async function deleteDashboard(
  db: Database,
  userId: string,
  dashboardId: string,
) {
  const deleted = await withAudit(db, { userId, source: "web" }, (tx) =>
    tx
      .deleteFrom("dashboards")
      .where("id", "=", dashboardId)
      .returning("id")
      .execute(),
  );
  if (deleted.length === 0) throw new AppError("unknown_dashboard");
}

async function assertTableInBase(
  db: Database,
  baseId: string,
  tableId: string,
): Promise<void> {
  const table = await db
    .selectFrom("dataTables")
    .select("id")
    .where("id", "=", tableId)
    .where("baseId", "=", baseId)
    .where(liveTable())
    .executeTakeFirst();
  if (!table) throw new AppError("unknown_table");
}

async function assertViewInTable(
  db: Database,
  tableId: string,
  viewId: string | undefined,
): Promise<void> {
  if (!viewId) return;
  const view = await db
    .selectFrom("views")
    .select("id")
    .where("id", "=", viewId)
    .where("tableId", "=", tableId)
    .where(liveView())
    .executeTakeFirst();
  if (!view) throw new AppError("unknown_view");
}

export async function upsertWidget(
  db: Database,
  userId: string,
  baseId: string,
  input: UpsertWidgetInput,
  source = "web",
) {
  const parsed = dashboardWidgetConfigSchema.parse({
    kind: input.kind,
    config: input.config,
  });
  await assertTableInBase(db, baseId, parsed.config.tableId);
  await assertViewInTable(
    db,
    parsed.config.tableId,
    "viewId" in parsed.config ? parsed.config.viewId : undefined,
  );
  const fields = {
    kind: input.kind,
    title: input.title,
    x: input.x,
    y: input.y,
    w: input.w,
    h: input.h,
    config: parsed.config as Record<string, unknown>,
  };

  if (input.widgetId) {
    const widgetId = input.widgetId;
    const updated = await withAudit(db, { userId, source }, async (tx) => {
      const row = await tx
        .updateTable("dashboardWidgets")
        .set(fields)
        .where("id", "=", widgetId)
        .where("dashboardId", "=", input.dashboardId)
        .returningAll()
        .executeTakeFirst();
      if (!row) throw new AppError("unknown_widget");
      await tx
        .updateTable("dashboards")
        .set({ updatedAt: new Date() })
        .where("id", "=", input.dashboardId)
        .execute();
      return row;
    });
    return updated;
  }

  const created = await withAudit(db, { userId, source: "web" }, async (tx) => {
    const row = await tx
      .insertInto("dashboardWidgets")
      .values({ dashboardId: input.dashboardId, ...fields })
      .returningAll()
      .executeTakeFirst();
    if (!row) throw new Error("Internal error");
    await tx
      .updateTable("dashboards")
      .set({ updatedAt: new Date() })
      .where("id", "=", input.dashboardId)
      .execute();
    return row;
  });
  return created;
}

export async function deleteWidget(
  db: Database,
  userId: string,
  dashboardId: string,
  widgetId: string,
) {
  await withAudit(db, { userId, source: "web" }, async (tx) => {
    const deleted = await tx
      .deleteFrom("dashboardWidgets")
      .where("id", "=", widgetId)
      .where("dashboardId", "=", dashboardId)
      .returning("id")
      .execute();
    if (deleted.length === 0) throw new AppError("unknown_widget");
    await tx
      .updateTable("dashboards")
      .set({ updatedAt: new Date() })
      .where("id", "=", dashboardId)
      .execute();
  });
}

export async function layoutWidgets(
  db: Database,
  userId: string,
  dashboardId: string,
  widgets: ReadonlyArray<{
    id: string;
    x: number;
    y: number;
    w: number;
    h: number;
  }>,
) {
  if (widgets.length === 0) return;
  // A layout is applied whole, or not at all.
  await withAudit(db, { userId, source: "web" }, async (tx) => {
    for (const widget of widgets) {
      const moved = await tx
        .updateTable("dashboardWidgets")
        .set({ x: widget.x, y: widget.y, w: widget.w, h: widget.h })
        .where("id", "=", widget.id)
        .where("dashboardId", "=", dashboardId)
        .returning("id")
        .executeTakeFirst();
      if (!moved) throw new AppError("unknown_widget");
    }
    await tx
      .updateTable("dashboards")
      .set({ updatedAt: new Date() })
      .where("id", "=", dashboardId)
      .execute();
  });
}

async function viewFilterSpec(
  db: Database,
  tableId: string,
  viewId: string | undefined,
  userId: string,
  timeZone: string,
  extra?: Partial<ReadSpec>,
): Promise<Omit<ReadSpec, "limit"> & { limit: number }> {
  let filter: ReadSpec["filter"];
  let search: string | undefined;
  if (viewId) {
    const view = await loadView(db, viewId);
    if (view.tableId !== tableId || (view.ownerId && view.ownerId !== userId)) {
      throw new AppError("invalid_view");
    }
    const config = pruneViewConfig(
      normalizeViewConfig(view.config, view.viewType),
      await liveColumnNames(db, tableId),
    );
    filter = config.filter;
    search = config.search;
  }
  return {
    filter,
    search,
    timeZone,
    me: userId,
    limit: 1,
    ...extra,
  };
}

export async function widgetData(
  deps: { db: Database },
  input: {
    widget: WidgetRow;
    userId: string;
    bindings: readonly Binding[];
    canReadTable: (tableId: string) => boolean;
    timeZone: string;
  },
): Promise<
  | { kind: "metric"; value: unknown; fn: AggregateFn; column: string }
  | ({
      kind: "chart";
      chartType: ChartType;
      fn: AggregateFn;
      keyTypes: { category: string | null; series: string | null };
      /**
       * A histogram's least and greatest value: its bins share what lies
       * between them equally, and the reader's page names each bin.
       */
      bounds: { lo: number; hi: number } | null;
      /** Series side by side, where they would stand one on another. */
      sideBySide: boolean;
      /**
       * What a category of dates covers past a day: its key is the first
       * day of that week, month, quarter, or year.
       */
      period: Exclude<ChartPeriod, "day"> | null;
    } & ReturnType<typeof chartSeries>)
  | { kind: "view_embed"; tableId: string; viewId: string }
> {
  const parsed = dashboardWidgetConfigSchema.parse({
    kind: input.widget.kind,
    config: input.widget.config,
  });
  if (!input.canReadTable(parsed.config.tableId)) {
    throw new AppError("access_denied");
  }

  if (parsed.kind === "view_embed") {
    return {
      kind: "view_embed",
      tableId: parsed.config.tableId,
      viewId: parsed.config.viewId,
    };
  }

  // Widgets read as the viewer: their roles, field rules, and row rules.
  const { engine } = await readerEngine(deps.db, parsed.config.tableId, {
    userId: input.userId,
    bindings: input.bindings,
  });
  const timeZone = safeTimeZone(input.timeZone);

  if (parsed.kind === "metric") {
    const items: AggregateItem[] = [
      { column: parsed.config.column, fn: parsed.config.fn },
    ];
    const spec = await viewFilterSpec(
      deps.db,
      parsed.config.tableId,
      parsed.config.viewId,
      input.userId,
      timeZone,
    );
    const [value] = await aggregateRows(deps.db, engine, spec, items);
    return {
      kind: "metric",
      value,
      fn: parsed.config.fn,
      column: parsed.config.column,
    };
  }

  const config = parsed.config;
  const spec = await viewFilterSpec(
    deps.db,
    config.tableId,
    config.viewId,
    input.userId,
    timeZone,
  );
  // A view's filter on fields kept in AnyGridDB resolves to row ids first,
  // as in the grid (ADR 0046).
  const viewed: ReadSpec = {
    filter: spec.filter,
    search: spec.search,
    timeZone,
    me: spec.me,
    limit: 1,
  };
  const scoped = engine.table.external
    ? await applyControlPlaneReadSpec(deps.db, engine, viewed)
    : viewed;
  // The client formats keys in the reader's language: a checkbox, a date.
  const typeOf = (name: string | undefined) =>
    engine.table.columns.find((column) => column.name === name)?.fieldType ??
    null;

  if (config.chartType === "histogram") {
    const column = config.column;
    if (!column) throw new AppError("invalid_arguments");
    const bins = config.bins ?? DEFAULT_HISTOGRAM_BINS;
    // The least and the greatest value, then the bins between them, read
    // in one transaction: a row written meanwhile is in both or neither.
    const found =
      scoped === null
        ? null
        : await readTransaction(deps.db, engine, async (run) => {
            const { limit: _limit, ...within } = scoped;
            const [edges] = await run(
              buildAggregates(engine, within, [
                { column, fn: "min" },
                { column, fn: "max" },
              ]),
            );
            const lo = decimalToNumber(edges?.a0);
            const hi = decimalToNumber(edges?.a1);
            // No value at all, or one past what a chart's axis holds.
            if (
              lo === undefined ||
              hi === undefined ||
              !Number.isFinite(lo) ||
              !Number.isFinite(hi)
            ) {
              return null;
            }
            return {
              lo,
              hi,
              rows: await run(
                buildHistogram(engine, within, { column, lo, hi, bins }),
              ),
            };
          });
    return {
      kind: "chart",
      chartType: "histogram",
      fn: "count_all",
      keyTypes: { category: typeOf(column), series: null },
      bounds: found ? { lo: found.lo, hi: found.hi } : null,
      sideBySide: false,
      period: null,
      ...histogramSeries(
        found?.rows.map((row) => ({ bin: row.k0, rows: row.a0 })) ?? [],
        // Every value the same: one bin holds them all.
        found ? (found.lo === found.hi ? 1 : bins) : 0,
      ),
    };
  }

  const groupBy = config.groupBy;
  if (!groupBy) throw new AppError("invalid_arguments");
  // Dates grouped by more than a day: the engine brings each back to
  // the first day of its week, month, quarter, or year.
  const span =
    config.period === undefined || config.period === "day"
      ? undefined
      : config.period;
  const groups = [
    groupBy,
    ...(config.seriesBy && config.seriesBy !== groupBy
      ? [config.seriesBy]
      : []),
  ];
  // Computed by the engine the rows live in (ADR 0005): one aggregate per
  // group, not the rows themselves.
  const rows =
    scoped === null
      ? []
      : await readTransaction(deps.db, engine, (run) => {
          const { limit: _limit, ...within } = scoped;
          return run(
            buildGroupAggregates(engine, within, {
              groups,
              item: { column: config.column ?? groupBy, fn: config.fn },
              spans: [span],
            }),
          );
        });
  return {
    kind: "chart",
    chartType: config.chartType,
    fn: config.fn,
    keyTypes: {
      category: typeOf(groupBy),
      series: groups.length > 1 ? typeOf(config.seriesBy) : null,
    },
    bounds: null,
    period: span ?? null,
    sideBySide: config.sideBySide === true,
    ...chartSeries(
      engine.table.columns,
      {
        groupBy,
        seriesBy: config.seriesBy,
        fn: config.fn,
        order: config.order,
        limit: config.limit,
      },
      rows.map((row) => ({
        key: row.k0,
        series: groups.length > 1 ? row.k1 : undefined,
        value: row.a0,
      })),
    ),
  };
}

/**
 * A histogram's bins in their order, each named by its place from 0, with
 * the rows the database counted in it: a bin no row fell in holds none,
 * and draws at zero, which is what it says.
 */
export function histogramSeries(
  rows: ReadonlyArray<{ bin: unknown; rows: unknown }>,
  bins: number,
): ReturnType<typeof chartSeries> {
  const counted = new Map<number, number>();
  for (const row of rows) {
    const bin = decimalToNumber(row.bin);
    const count = decimalToNumber(row.rows);
    if (bin === undefined || count === undefined) continue;
    counted.set(bin, (counted.get(bin) ?? 0) + count);
  }
  const places = Array.from({ length: bins }, (_, index) => index);
  return {
    categories: places.map(String),
    series: [{ name: "", values: places.map((bin) => counted.get(bin) ?? 0) }],
    omitted: { categories: 0, series: 0 },
  };
}

/** Series drawn, at most: more fold into "Others". */
const MAX_SERIES = 8;
/** Aggregates that add up: series past the limit fold into one. */
const ADDITIVE = new Set<AggregateFn>([
  "count_all",
  "count_empty",
  "count_filled",
  "sum",
  "checked",
  "unchecked",
]);

type ChartColumn = {
  name: string;
  fieldType: string;
  config: Parameters<typeof selectOptionNames>[0];
};

/** A group's key as text: empty groups read "(vide)". */
function keyText(value: unknown): string {
  return value === null || value === undefined || value === ""
    ? "(vide)"
    : cellText(value);
}

/** Keys in the field's own order: a select's options, else naturally. */
function keyOrder(columns: readonly ChartColumn[], name: string | undefined) {
  const column = columns.find((item) => item.name === name);
  const options =
    column?.fieldType === "single_select"
      ? selectOptionNames(column.config)
      : [];
  const rank = (key: string) => {
    const at = options.indexOf(key);
    return at === -1 ? options.length : at;
  };
  return (left: string, right: string) =>
    rank(left) - rank(right) ||
    left.localeCompare(right, undefined, { numeric: true });
}

/**
 * The chart's categories and series from one aggregate per group: values
 * as numbers (only drawing turns an exact decimal into one), a missing
 * pair as null. Past eight series, the smallest fold into "Others" when
 * the aggregate adds up, and are left out otherwise.
 */
export function chartSeries(
  columns: readonly ChartColumn[],
  config: {
    groupBy: string;
    seriesBy?: string | undefined;
    fn: AggregateFn;
    /** By value, greatest first; the field's own order unless said. */
    order?: ChartOrder | undefined;
    /** The categories drawn, the first of that order. */
    limit?: number | undefined;
  },
  rows: ReadonlyArray<{ key: unknown; series: unknown; value: unknown }>,
): {
  categories: string[];
  series: Array<{ name: string; values: Array<number | null> }>;
  omitted: { categories: number; series: number };
} {
  // A group whose values are all empty has no value: it draws nothing,
  // rather than a bar at zero.
  const byKey = new Map<string, Map<string, number | null>>();
  const seriesTotal = new Map<string, number>();
  for (const row of rows) {
    const key = keyText(row.key);
    const name = row.series === undefined ? "" : keyText(row.series);
    const value = decimalToNumber(row.value) ?? null;
    const cell = byKey.get(key) ?? new Map<string, number | null>();
    const before = cell.get(name) ?? null;
    cell.set(name, value === null ? before : (before ?? 0) + value);
    byKey.set(key, cell);
    seriesTotal.set(name, (seriesTotal.get(name) ?? 0) + Math.abs(value ?? 0));
  }
  const ownOrder = keyOrder(columns, config.groupBy);
  // A category's value across its series: their total when the measure
  // adds up, the greatest of them otherwise. One without a value is last.
  const worth = new Map<string, number>();
  for (const [key, cell] of byKey) {
    const values = [...cell.values()].filter(
      (value): value is number => value !== null,
    );
    if (values.length === 0) continue;
    worth.set(
      key,
      ADDITIVE.has(config.fn)
        ? values.reduce((sum, value) => sum + value, 0)
        : Math.max(...values),
    );
  }
  const byValue = (left: string, right: string) => {
    const a = worth.get(left);
    const b = worth.get(right);
    if (a === undefined || b === undefined) {
      return a === b ? ownOrder(left, right) : a === undefined ? 1 : -1;
    }
    return b - a || ownOrder(left, right);
  };
  const allCategories = [...byKey.keys()].sort(
    config.order === "value" ? byValue : ownOrder,
  );
  const categories = allCategories.slice(
    0,
    Math.min(config.limit ?? MAX_CHART_CATEGORIES, MAX_CHART_CATEGORIES),
  );
  const ranked = [...seriesTotal.keys()].sort(
    (left, right) =>
      (seriesTotal.get(right) ?? 0) - (seriesTotal.get(left) ?? 0),
  );
  const fold = ranked.length > MAX_SERIES;
  const kept = new Set(ranked.slice(0, fold ? MAX_SERIES - 1 : MAX_SERIES));
  const names = [...kept].sort(keyOrder(columns, config.seriesBy));
  const series = names.map((name) => ({
    name,
    values: categories.map((key) => byKey.get(key)?.get(name) ?? null),
  }));
  const rest = ranked.filter((name) => !kept.has(name));
  if (fold && ADDITIVE.has(config.fn)) {
    series.push({
      name: "(autres)",
      values: categories.map((key) => {
        const cell = byKey.get(key);
        const values = rest
          .map((name) => cell?.get(name) ?? null)
          .filter((value): value is number => value !== null);
        return values.length > 0
          ? values.reduce((sum, value) => sum + value, 0)
          : null;
      }),
    });
  }
  return {
    categories,
    series,
    omitted: {
      categories: allCategories.length - categories.length,
      series: fold && !ADDITIVE.has(config.fn) ? rest.length : 0,
    },
  };
}
