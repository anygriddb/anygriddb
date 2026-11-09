import {
  type AggregateFn,
  type AggregateItem,
  AppError,
  type Binding,
  buildGroupAggregates,
  cellText,
  type ChartType,
  type CreateDashboardInput,
  dashboardWidgetConfigSchema,
  decimalToNumber,
  normalizeViewConfig,
  pruneViewConfig,
  type ReadSpec,
  selectOptionNames,
  type UpsertWidgetInput,
} from "@anygriddb/core";
import type { Database, DashboardRow, WidgetRow } from "@anygriddb/db";
import { readerEngine } from "./acl.js";
import { liveColumnNames, liveTable, liveView } from "./live.js";
import { aggregateRows, readTransaction, safeTimeZone } from "./rows.js";
import { loadView } from "./views.js";

export type { DashboardRow, WidgetRow };

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
  const created = await db
    .insertInto("dashboards")
    .values({
      baseId: input.baseId,
      name: input.name,
      description: input.description,
      position,
    })
    .returningAll()
    .executeTakeFirst();
  if (!created) throw new Error("Internal error");
  return created;
}

export async function updateDashboard(
  db: Database,
  input: {
    dashboardId: string;
    name?: string;
    description?: string | null;
  },
) {
  const updated = await db
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
    .executeTakeFirst();
  if (!updated) throw new AppError("unknown_dashboard");
  return updated;
}

export async function deleteDashboard(db: Database, dashboardId: string) {
  const deleted = await db
    .deleteFrom("dashboards")
    .where("id", "=", dashboardId)
    .returning("id")
    .execute();
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
  baseId: string,
  input: UpsertWidgetInput,
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
    const updated = await db
      .updateTable("dashboardWidgets")
      .set(fields)
      .where("id", "=", input.widgetId)
      .where("dashboardId", "=", input.dashboardId)
      .returningAll()
      .executeTakeFirst();
    if (!updated) throw new AppError("unknown_widget");
    await touchDashboard(db, input.dashboardId);
    return updated;
  }

  const created = await db
    .insertInto("dashboardWidgets")
    .values({ dashboardId: input.dashboardId, ...fields })
    .returningAll()
    .executeTakeFirst();
  if (!created) throw new Error("Internal error");
  await touchDashboard(db, input.dashboardId);
  return created;
}

export async function deleteWidget(
  db: Database,
  dashboardId: string,
  widgetId: string,
) {
  const deleted = await db
    .deleteFrom("dashboardWidgets")
    .where("id", "=", widgetId)
    .where("dashboardId", "=", dashboardId)
    .returning("id")
    .execute();
  if (deleted.length === 0) throw new AppError("unknown_widget");
  await touchDashboard(db, dashboardId);
}

export async function layoutWidgets(
  db: Database,
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
  await db.transaction().execute(async (tx) => {
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
  });
  await touchDashboard(db, dashboardId);
}

async function touchDashboard(db: Database, dashboardId: string) {
  await db
    .updateTable("dashboards")
    .set({ updatedAt: new Date() })
    .where("id", "=", dashboardId)
    .execute();
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
  const groups = [
    config.groupBy,
    ...(config.seriesBy && config.seriesBy !== config.groupBy
      ? [config.seriesBy]
      : []),
  ];
  // Computed by the engine the rows live in (ADR 0005): one aggregate per
  // group, not the rows themselves.
  const rows = await readTransaction(deps.db, engine, (run) =>
    run(
      buildGroupAggregates(
        engine,
        { filter: spec.filter, search: spec.search, timeZone, me: spec.me },
        {
          groups,
          item: { column: config.column ?? config.groupBy, fn: config.fn },
        },
      ),
    ),
  );
  // The client formats keys in the reader's language: a checkbox, a date.
  const typeOf = (name: string | undefined) =>
    engine.table.columns.find((column) => column.name === name)?.fieldType ??
    null;
  return {
    kind: "chart",
    chartType: config.chartType,
    fn: config.fn,
    keyTypes: {
      category: typeOf(config.groupBy),
      series: groups.length > 1 ? typeOf(config.seriesBy) : null,
    },
    ...chartSeries(
      engine.table.columns,
      config,
      rows.map((row) => ({
        key: row.k0,
        series: groups.length > 1 ? row.k1 : undefined,
        value: row.a0,
      })),
    ),
  };
}

/** Categories on the x axis, at most this many; the rest are counted. */
const MAX_CATEGORIES = 40;
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
  config: { groupBy: string; seriesBy?: string | undefined; fn: AggregateFn },
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
    cell.set(
      name,
      value === null ? before : (before ?? 0) + value,
    );
    byKey.set(key, cell);
    seriesTotal.set(
      name,
      (seriesTotal.get(name) ?? 0) + Math.abs(value ?? 0),
    );
  }
  const allCategories = [...byKey.keys()].sort(
    keyOrder(columns, config.groupBy),
  );
  const categories = allCategories.slice(0, MAX_CATEGORIES);
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
