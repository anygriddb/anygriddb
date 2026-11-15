import { describe, expect, it } from "vitest";
import {
  createDashboardInputSchema,
  dashboardWidgetConfigSchema,
  upsertWidgetInputSchema,
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
});
