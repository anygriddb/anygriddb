import { describe, expect, it } from "vitest";
import {
  createDashboardInputSchema,
  dashboardWidgetConfigSchema,
  upsertWidgetInputSchema,
  widgetConfigOn,
  widgetSettings,
} from "./dashboards";

const id = "0b5c4f3e-8a5e-4c43-9f61-2d4b8d1c7a10";

describe("dashboard schemas", () => {
  it("accepts a named dashboard", () => {
    expect(
      createDashboardInputSchema.parse({ baseId: id, name: "Pilotage" }).name,
    ).toBe("Pilotage");
  });

  it("checks widget configs by kind", () => {
    expect(
      dashboardWidgetConfigSchema.safeParse({
        kind: "metric",
        config: { tableId: id, column: "amount", fn: "sum" },
      }).success,
    ).toBe(true);
    expect(
      dashboardWidgetConfigSchema.safeParse({
        kind: "chart",
        config: {
          tableId: id,
          groupBy: "status",
          chartType: "pie",
        },
      }).success,
    ).toBe(true);
    // A figure reads an aggregate, or the last value by the field that
    // puts the rows in order: the one needs no order, the other has one.
    const figure = (config: Record<string, unknown>) =>
      dashboardWidgetConfigSchema.safeParse({
        kind: "metric",
        config: { tableId: id, column: "balance", ...config },
      }).success;
    expect(figure({ fn: "last", orderBy: "day" })).toBe(true);
    expect(figure({ fn: "last" })).toBe(false);
    expect(figure({ fn: "sum", orderBy: "day" })).toBe(false);
    expect(figure({ fn: "first", orderBy: "day" })).toBe(false);
    // A histogram bins one number field and counts rows.
    const histogram = (config: Record<string, unknown>) =>
      dashboardWidgetConfigSchema.safeParse({
        kind: "chart",
        config: { tableId: id, chartType: "histogram", ...config },
      }).success;
    expect(histogram({ column: "amount" })).toBe(true);
    expect(histogram({ column: "amount", bins: 12 })).toBe(true);
    expect(histogram({})).toBe(false);
    expect(histogram({ column: "amount", bins: 1 })).toBe(false);
    expect(histogram({ column: "amount", bins: 41 })).toBe(false);
    expect(histogram({ column: "amount", groupBy: "status" })).toBe(false);
    expect(histogram({ column: "amount", seriesBy: "status" })).toBe(false);
    expect(histogram({ column: "amount", fn: "sum" })).toBe(false);
    // Any other chart groups by a field, and has no bins.
    const columns = (config: Record<string, unknown>) =>
      dashboardWidgetConfigSchema.safeParse({
        kind: "chart",
        config: { tableId: id, chartType: "bar", ...config },
      }).success;
    expect(columns({ groupBy: "status" })).toBe(true);
    expect(columns({})).toBe(false);
    expect(columns({ groupBy: "status", bins: 12 })).toBe(false);
    expect(
      dashboardWidgetConfigSchema.safeParse({
        kind: "chart",
        config: { tableId: id, groupBy: "status", chartType: "scatter" },
      }).success,
    ).toBe(false);
    expect(
      dashboardWidgetConfigSchema.safeParse({
        kind: "view_embed",
        config: { tableId: id },
      }).success,
    ).toBe(false);
  });

  it("takes a chart's order, how many categories it draws, and series side by side", () => {
    const chart = (config: object) =>
      dashboardWidgetConfigSchema.safeParse({
        kind: "chart",
        config: { tableId: id, groupBy: "status", ...config },
      }).success;
    expect(chart({ order: "value", limit: 15, sideBySide: true })).toBe(true);
    expect(chart({ chartType: "line", order: "field", limit: 40 })).toBe(true);
    // Past what a chart draws, and an order nobody knows.
    expect(chart({ limit: 41 })).toBe(false);
    expect(chart({ limit: 0 })).toBe(false);
    expect(chart({ order: "random" })).toBe(false);
    // Dates grouped by a month; shares take a period too.
    expect(chart({ period: "month" })).toBe(true);
    expect(chart({ chartType: "pie", period: "quarter" })).toBe(true);
    expect(chart({ period: "decade" })).toBe(false);
    // Shares are each of the whole, largest first: nothing to choose.
    expect(chart({ chartType: "pie", limit: 5 })).toBe(false);
    expect(chart({ chartType: "pie", order: "value" })).toBe(false);
    expect(chart({ chartType: "pie", sideBySide: true })).toBe(false);
    expect(
      dashboardWidgetConfigSchema.safeParse({
        kind: "chart",
        config: {
          tableId: id,
          chartType: "histogram",
          column: "amount",
          limit: 5,
        },
      }).success,
    ).toBe(false);
    expect(
      dashboardWidgetConfigSchema.safeParse({
        kind: "chart",
        config: {
          tableId: id,
          chartType: "histogram",
          column: "amount",
          period: "month",
        },
      }).success,
    ).toBe(false);
  });

  it("refuses an upsert whose config does not match its kind", () => {
    expect(
      upsertWidgetInputSchema.safeParse({
        dashboardId: id,
        title: "Total",
        kind: "metric",
        config: { tableId: id, viewId: id },
      }).success,
    ).toBe(false);
  });

  it("parts a widget's settings from the table and the view it reads", () => {
    const other = "7d2f4b1a-3c5e-4f6a-8b9c-0d1e2f3a4b5c";
    const config = {
      tableId: id,
      viewId: id,
      column: "amount",
      fn: "sum",
    };
    // What a copy of the dashboard keeps: no id of the base it leaves.
    const settings = widgetSettings(config);
    expect(settings).toEqual({ column: "amount", fn: "sum" });
    // Given a table and a view of another base, a widget's config again.
    const placed = widgetConfigOn(settings, other, other);
    expect(placed).toEqual({ ...config, tableId: other, viewId: other });
    expect(
      dashboardWidgetConfigSchema.safeParse({ kind: "metric", config: placed })
        .success,
    ).toBe(true);
    // A widget that reads the whole table names no view.
    expect(widgetConfigOn(settings, other)).toEqual({
      column: "amount",
      fn: "sum",
      tableId: other,
    });
    // Rows drawn from a view need it: without, the config is refused.
    expect(
      dashboardWidgetConfigSchema.safeParse({
        kind: "view_embed",
        config: widgetConfigOn({}, other),
      }).success,
    ).toBe(false);
  });
});
