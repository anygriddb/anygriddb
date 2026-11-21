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
import { authorize, baseAccess, guardBase, handle } from "./guard.js";
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
      const actor = await authorize(ctx);
      const dashboard = await loadDashboard(ctx.db, input.dashboardId);
      await baseAccess(ctx, actor, dashboard.baseId, "read");
      return getDashboard(ctx.db, input.dashboardId);
    }),
  ),
  create: procedure
    .input(createDashboardInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const { user } = await guardBase(ctx, input.baseId, "manage");
        return createDashboard(ctx.db, user.id, input);
      }),
    ),
  update: procedure
    .input(updateDashboardInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const actor = await authorize(ctx);
        const dashboard = await loadDashboard(ctx.db, input.dashboardId);
        const { user } = await baseAccess(
          ctx,
          actor,
          dashboard.baseId,
          "manage",
        );
        return updateDashboard(ctx.db, user.id, input);
      }),
    ),
  delete: procedure
    .input(deleteDashboardInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const actor = await authorize(ctx);
        const dashboard = await loadDashboard(ctx.db, input.dashboardId);
        const { user } = await baseAccess(
          ctx,
          actor,
          dashboard.baseId,
          "manage",
        );
        await deleteDashboard(ctx.db, user.id, input.dashboardId);
        return { ok: true as const };
      }),
    ),
  upsertWidget: procedure
    .input(upsertWidgetInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const actor = await authorize(ctx);
        const dashboard = await loadDashboard(ctx.db, input.dashboardId);
        const { user } = await baseAccess(
          ctx,
          actor,
          dashboard.baseId,
          "manage",
        );
        return upsertWidget(ctx.db, user.id, dashboard.baseId, input);
      }),
    ),
  deleteWidget: procedure
    .input(deleteWidgetInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const actor = await authorize(ctx);
        const dashboard = await loadDashboard(ctx.db, input.dashboardId);
        const { user } = await baseAccess(
          ctx,
          actor,
          dashboard.baseId,
          "manage",
        );
        await deleteWidget(ctx.db, user.id, input.dashboardId, input.widgetId);
        return { ok: true as const };
      }),
    ),
  layout: procedure.input(layoutWidgetsInputSchema).mutation(({ ctx, input }) =>
    handle(ctx, async () => {
      const actor = await authorize(ctx);
      const dashboard = await loadDashboard(ctx.db, input.dashboardId);
      const { user } = await baseAccess(ctx, actor, dashboard.baseId, "manage");
      await layoutWidgets(ctx.db, user.id, input.dashboardId, input.widgets);
      return { ok: true as const };
    }),
  ),
  widgetData: procedure.input(widgetDataInputSchema).query(({ ctx, input }) =>
    handle(ctx, async () => {
      const actor = await authorize(ctx);
      const { user, bindings } = actor;
      const { dashboard, widgets } = await getDashboard(
        ctx.db,
        input.dashboardId,
      );
      await baseAccess(ctx, actor, dashboard.baseId, "read");
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
