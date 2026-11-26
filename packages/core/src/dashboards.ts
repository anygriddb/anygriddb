import { ceilingOf } from "./limits";
import { z } from "zod";
import { columnNameSchema, labelSchema } from "./names";
import { AGGREGATE_FNS, MAX_HISTOGRAM_BINS } from "./query/read";
import { descriptionSchema } from "./schemas";

export const DASHBOARD_WIDGET_KINDS = [
  "metric",
  "chart",
  "view_embed",
] as const;
/**
 * Columns, bars, a line, an area, each group's share of the total
 * (`pie`, kept for saved charts: drawn as bars of shares, which compare
 * better than slices), or the rows counted in equal bins of a number
 * field (`histogram`).
 */
const CHART_TYPES = [
  "bar",
  "bar_horizontal",
  "line",
  "area",
  "pie",
  "histogram",
] as const;
export type ChartType = (typeof CHART_TYPES)[number];
/** The bins of a histogram that does not say how many it has. */
export const DEFAULT_HISTOGRAM_BINS = 12;
/** The categories a chart draws, at most: the rest are counted. */
export const MAX_CHART_CATEGORIES = ceilingOf("chart.categories");
/**
 * A chart's categories in their field's own order (a list's options,
 * else the alphabet, a date's days), or by their value, greatest first.
 */
const CHART_ORDERS = ["field", "value"] as const;
export type ChartOrder = (typeof CHART_ORDERS)[number];
/**
 * What a category of dates covers: each day, or the days of a week (from
 * Monday), a month, a quarter, or a year together.
 */
const CHART_PERIODS = ["day", "week", "month", "quarter", "year"] as const;
export type ChartPeriod = (typeof CHART_PERIODS)[number];

/**
 * What a figure measures: an aggregate of its field over the rows, or the
 * value the field holds in the last of them (`last`).
 */
const METRIC_FNS = [...AGGREGATE_FNS, "last"] as const;
export type MetricFn = (typeof METRIC_FNS)[number];

const gridInt = (max: number) => z.int().min(0).max(max);

/** The lowest row of the grid a widget may stand on. */
export const WIDGET_ROW_MAX = 200;

/**
 * The size a widget takes when none is given, by its kind: a figure is
 * small, a chart and a view are wide.
 */
export const WIDGET_SIZES: Record<
  (typeof DASHBOARD_WIDGET_KINDS)[number],
  { w: number; h: number }
> = {
  metric: { w: 3, h: 2 },
  chart: { w: 6, h: 4 },
  view_embed: { w: 6, h: 4 },
};

/** Where a widget sits on the dashboard's twelve columns, and its size. */
export const widgetPlace = {
  x: gridInt(11),
  y: gridInt(WIDGET_ROW_MAX),
  w: z.int().min(2).max(12),
  h: z.int().min(2).max(12),
};

const metricConfigSchema = z
  .object({
    tableId: z.uuid(),
    viewId: z.uuid().optional(),
    column: columnNameSchema,
    fn: z.enum(METRIC_FNS),
    /**
     * The field that puts the rows in order for the last value: the last
     * row holds its greatest value and, among several that do, is the
     * one made last.
     */
    orderBy: columnNameSchema.optional(),
  })
  .strict()
  // The last value is the last by a field; an aggregate has no order.
  .superRefine((config, context) => {
    if (config.fn === "last" && config.orderBy === undefined) {
      context.addIssue({
        code: "custom",
        message: "The last value needs the field that orders the rows",
        path: ["orderBy"],
      });
    }
    if (config.fn !== "last" && config.orderBy !== undefined) {
      context.addIssue({
        code: "custom",
        message: "Only the last value is ordered",
        path: ["orderBy"],
      });
    }
  });

const chartConfigSchema = z
  .object({
    tableId: z.uuid(),
    viewId: z.uuid().optional(),
    /** The field whose values name the groups; a histogram has none. */
    groupBy: columnNameSchema.optional(),
    /** A second field: one series per value, stacked or side by side. */
    seriesBy: columnNameSchema.optional(),
    chartType: z.enum(CHART_TYPES).default("bar"),
    /**
     * The field a measure reads; without one, rows are counted. A
     * histogram needs it: the number field it bins.
     */
    column: columnNameSchema.optional(),
    /** How many equal bins a histogram has. */
    bins: z.int().min(2).max(MAX_HISTOGRAM_BINS).optional(),
    /** What a category covers when the groups are dates: a day unless said. */
    period: z.enum(CHART_PERIODS).optional(),
    /** The order of the categories: the field's own unless said. */
    order: z.enum(CHART_ORDERS).optional(),
    /** How many categories are drawn, the first of that order. */
    limit: z.int().min(1).max(MAX_CHART_CATEGORIES).optional(),
    /** Series drawn side by side, where they would stand one on another. */
    sideBySide: z.boolean().optional(),
    // The median needs each group's rows again: not per group.
    fn: z
      .enum(AGGREGATE_FNS)
      .refine((fn) => fn !== "median")
      .default("count_all"),
  })
  .strict()
  // A histogram bins one number field and counts rows: it has no groups,
  // no series and no other measure. Every other chart groups by a field.
  .superRefine((config, context) => {
    const refuse = (path: string, message: string) =>
      context.addIssue({ code: "custom", message, path: [path] });
    // Shares are drawn largest first, each of the whole: cutting some
    // out would make the rest add up to a hundred. Bins are in their order.
    if (config.chartType === "pie" || config.chartType === "histogram") {
      if (config.order !== undefined)
        refuse("order", "This chart has its own order");
      if (config.limit !== undefined)
        refuse("limit", "This chart draws every category");
      if (config.sideBySide !== undefined)
        refuse("sideBySide", "This chart has no series to set apart");
    }
    if (config.chartType !== "histogram") {
      if (!config.groupBy) refuse("groupBy", "A chart groups by a field");
      if (config.bins !== undefined)
        refuse("bins", "Only a histogram has bins");
      return;
    }
    if (!config.column) refuse("column", "A histogram bins a field");
    if (config.period !== undefined)
      refuse("period", "A histogram has no dates to group");
    if (config.groupBy) refuse("groupBy", "A histogram has no groups");
    if (config.seriesBy) refuse("seriesBy", "A histogram has no series");
    if (config.fn !== "count_all") refuse("fn", "A histogram counts rows");
  });

const viewEmbedConfigSchema = z
  .object({
    tableId: z.uuid(),
    viewId: z.uuid(),
  })
  .strict();

export const dashboardWidgetConfigSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("metric"), config: metricConfigSchema }).strict(),
  z.object({ kind: z.literal("chart"), config: chartConfigSchema }).strict(),
  z
    .object({ kind: z.literal("view_embed"), config: viewEmbedConfigSchema })
    .strict(),
]);

/**
 * A widget's settings without the table and the view it reads. Those two
 * are ids of the widget's own base: a copy of its dashboard in another
 * base keeps the rest, and reads that base's.
 */
export function widgetSettings(
  config: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const { tableId: _tableId, viewId: _viewId, ...settings } = config;
  return settings;
}

/** Those settings, reading a table and, when the widget reads one, a view. */
export function widgetConfigOn(
  settings: Readonly<Record<string, unknown>>,
  tableId: string,
  viewId?: string,
): Record<string, unknown> {
  return { ...settings, tableId, ...(viewId === undefined ? {} : { viewId }) };
}

export const createDashboardInputSchema = z
  .object({
    baseId: z.uuid(),
    name: labelSchema,
    description: descriptionSchema.optional(),
  })
  .strict();

export const updateDashboardInputSchema = z
  .object({
    dashboardId: z.uuid(),
    name: labelSchema.optional(),
    description: descriptionSchema.nullable().optional(),
  })
  .strict();

export const deleteDashboardInputSchema = z
  .object({ dashboardId: z.uuid() })
  .strict();

export const listDashboardsInputSchema = z
  .object({ baseId: z.uuid() })
  .strict();

export const getDashboardInputSchema = z
  .object({ dashboardId: z.uuid() })
  .strict();

export const upsertWidgetInputSchema = z
  .object({
    dashboardId: z.uuid(),
    widgetId: z.uuid().optional(),
    title: labelSchema,
    kind: z.enum(DASHBOARD_WIDGET_KINDS),
    /**
     * Its place and its size on the grid. A new widget given none stands
     * under the others, at the size of its kind; one that is changed
     * keeps what it had.
     */
    x: gridInt(11).optional(),
    y: gridInt(WIDGET_ROW_MAX).optional(),
    w: z.int().min(2).max(12).optional(),
    h: z.int().min(2).max(12).optional(),
    config: z.record(z.string(), z.unknown()),
  })
  .strict()
  .superRefine((input, context) => {
    const parsed = dashboardWidgetConfigSchema.safeParse({
      kind: input.kind,
      config: input.config,
    });
    if (!parsed.success) {
      context.addIssue({
        code: "custom",
        message: "Invalid widget",
        path: ["config"],
      });
    }
  });

/** The settings of a widget that name a field of its table. */
const WIDGET_FIELD_KEYS = ["column", "groupBy", "seriesBy", "orderBy"] as const;

/** A widget's settings for a reader, without the fields hidden from them. */
export function widgetConfigForReader(
  config: Record<string, unknown>,
  hidden: (name: string) => boolean,
): Record<string, unknown> {
  const next = { ...config };
  for (const key of WIDGET_FIELD_KEYS) {
    const name = next[key];
    if (typeof name === "string" && hidden(name)) {
      Reflect.deleteProperty(next, key);
    }
  }
  return next;
}

export const deleteWidgetInputSchema = z
  .object({
    dashboardId: z.uuid(),
    widgetId: z.uuid(),
  })
  .strict();

export const layoutWidgetsInputSchema = z
  .object({
    dashboardId: z.uuid(),
    widgets: z
      .array(z.object({ id: z.uuid(), ...widgetPlace }).strict())
      .min(1)
      .max(48),
  })
  .strict();

export const widgetDataInputSchema = z
  .object({
    dashboardId: z.uuid(),
    widgetId: z.uuid(),
  })
  .strict();

export type CreateDashboardInput = z.infer<typeof createDashboardInputSchema>;
export type UpsertWidgetInput = z.infer<typeof upsertWidgetInputSchema>;
