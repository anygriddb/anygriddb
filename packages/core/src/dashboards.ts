import { z } from "zod";
import { columnNameSchema, labelSchema } from "./names";
import { AGGREGATE_FNS } from "./query/read";
import { descriptionSchema } from "./schemas";

const DASHBOARD_WIDGET_KINDS = ["metric", "chart", "view_embed"] as const;
/**
 * Columns, bars, a line, an area, or each group's share of the total
 * (`pie`, kept for saved charts: drawn as bars of shares, which compare
 * better than slices).
 */
const CHART_TYPES = ["bar", "bar_horizontal", "line", "area", "pie"] as const;
export type ChartType = (typeof CHART_TYPES)[number];

const gridInt = (max: number) => z.int().min(0).max(max);

const metricConfigSchema = z
  .object({
    tableId: z.uuid(),
    viewId: z.uuid().optional(),
    column: columnNameSchema,
    fn: z.enum(AGGREGATE_FNS),
  })
  .strict();

const chartConfigSchema = z
  .object({
    tableId: z.uuid(),
    viewId: z.uuid().optional(),
    groupBy: columnNameSchema,
    /** A second field: one series per value, stacked or side by side. */
    seriesBy: columnNameSchema.optional(),
    chartType: z.enum(CHART_TYPES).default("bar"),
    /** Value aggregate; defaults to counting rows per group. */
    column: columnNameSchema.optional(),
    // The median needs each group's rows again: not per group.
    fn: z
      .enum(AGGREGATE_FNS)
      .refine((fn) => fn !== "median")
      .default("count_all"),
  })
  .strict();

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
    x: gridInt(11).default(0),
    y: gridInt(200).default(0),
    w: z.int().min(2).max(12).default(4),
    h: z.int().min(2).max(12).default(3),
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
      .array(
        z
          .object({
            id: z.uuid(),
            x: gridInt(11),
            y: gridInt(200),
            w: z.int().min(2).max(12),
            h: z.int().min(2).max(12),
          })
          .strict(),
      )
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
