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
