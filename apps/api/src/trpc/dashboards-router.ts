import {
  AppError,
  createDashboardInputSchema,
  deleteDashboardInputSchema,
  deleteWidgetInputSchema,
  effectiveTableRole,
  getDashboardInputSchema,
  layoutWidgetsInputSchema,
  listDashboardsInputSchema,
  roleAllows,
  updateDashboardInputSchema,
  upsertWidgetInputSchema,
  widgetDataInputSchema,
} from "@anygriddb/core";
import {
  createDashboard,
  deleteDashboard,
  deleteWidget,
  getDashboard,
  layoutWidgets,
  listDashboards,
  loadDashboard,
  updateDashboard,
  upsertWidget,
  widgetData,
} from "../data/dashboards.js";
import { authorize, guardBase, handle } from "./guard.js";
import { procedure, t } from "./init.js";

export const dashboardsRouter = t.router({
  list: procedure.input(listDashboardsInputSchema).query(({ ctx, input }) =>
    handle(ctx, async () => {
      await guardBase(ctx, input.baseId, "read");
      return { dashboards: await listDashboards(ctx.db, input.baseId) };
    }),
  ),
  get: procedure.input(getDashboardInputSchema).query(({ ctx, input }) =>
    handle(ctx, async () => {
      const dashboard = await loadDashboard(ctx.db, input.dashboardId);
      await guardBase(ctx, dashboard.baseId, "read");
      return getDashboard(ctx.db, input.dashboardId);
    }),
  ),
  create: procedure
    .input(createDashboardInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        await guardBase(ctx, input.baseId, "manage");
        return createDashboard(ctx.db, input);
      }),
    ),
  update: procedure
    .input(updateDashboardInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const dashboard = await loadDashboard(ctx.db, input.dashboardId);
        await guardBase(ctx, dashboard.baseId, "manage");
        return updateDashboard(ctx.db, input);
      }),
    ),
  delete: procedure
    .input(deleteDashboardInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const dashboard = await loadDashboard(ctx.db, input.dashboardId);
        await guardBase(ctx, dashboard.baseId, "manage");
        await deleteDashboard(ctx.db, input.dashboardId);
        return { ok: true as const };
      }),
    ),
  upsertWidget: procedure
    .input(upsertWidgetInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const dashboard = await loadDashboard(ctx.db, input.dashboardId);
        await guardBase(ctx, dashboard.baseId, "manage");
        return upsertWidget(ctx.db, dashboard.baseId, input);
      }),
    ),
  deleteWidget: procedure
    .input(deleteWidgetInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const dashboard = await loadDashboard(ctx.db, input.dashboardId);
        await guardBase(ctx, dashboard.baseId, "manage");
        await deleteWidget(ctx.db, input.dashboardId, input.widgetId);
        return { ok: true as const };
      }),
    ),
  layout: procedure.input(layoutWidgetsInputSchema).mutation(({ ctx, input }) =>
    handle(ctx, async () => {
      const dashboard = await loadDashboard(ctx.db, input.dashboardId);
      await guardBase(ctx, dashboard.baseId, "manage");
      await layoutWidgets(ctx.db, input.dashboardId, input.widgets);
      return { ok: true as const };
    }),
  ),
  widgetData: procedure.input(widgetDataInputSchema).query(({ ctx, input }) =>
    handle(ctx, async () => {
      const { user, bindings } = await authorize(ctx);
      const { dashboard, widgets } = await getDashboard(
        ctx.db,
        input.dashboardId,
      );
      await guardBase(ctx, dashboard.baseId, "read");
      const widget = widgets.find((item) => item.id === input.widgetId);
      if (!widget) throw new AppError("unknown_widget");
      return widgetData(
        { db: ctx.db },
        {
          widget,
          userId: user.id,
          bindings,
          timeZone:
            typeof ctx.req.headers["x-timezone"] === "string"
              ? ctx.req.headers["x-timezone"]
              : "UTC",
          canReadTable: (tableId) =>
            roleAllows(
              effectiveTableRole(bindings, tableId, dashboard.baseId),
              "read",
            ),
        },
      );
    }),
  ),
});
