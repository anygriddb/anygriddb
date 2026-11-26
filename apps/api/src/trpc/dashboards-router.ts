import {
  AppError,
  createDashboardInputSchema,
  deleteDashboardInputSchema,
  deleteWidgetInputSchema,
  effectiveTableRole,
  getDashboardInputSchema,
  layoutWidgetsInputSchema,
  listDashboardsInputSchema,
  roleFor,
  roleGrants,
  updateDashboardInputSchema,
  upsertWidgetInputSchema,
  widgetDataInputSchema,
} from "@anygriddb/core";
import {
  createDashboard,
  deleteDashboard,
  dashboardsReadable,
  deleteWidget,
  getDashboard,
  layoutWidgets,
  listDashboards,
  loadDashboard,
  updateDashboard,
  upsertWidget,
  widgetData,
  widgetsForReader,
} from "../data/dashboards.js";
import { authorize, baseAccess, guardBase, handle } from "./guard.js";
import { asking, t } from "./init.js";
import type { Context } from "./context.js";

type Actor = Awaited<ReturnType<typeof authorize>>;

/**
 * A dashboard is read by whoever holds a role on its base, or by whoever
 * reaches the base through its tables when every widget reads a table they
 * read: no title nor field of another table shows to them.
 */
async function dashboardAccess(
  ctx: Context,
  actor: Actor,
  dashboard: { id: string; baseId: string },
): Promise<void> {
  await baseAccess(ctx, actor, dashboard.baseId, "rows.read", "tables");
  if (roleFor(actor.bindings, "base", dashboard.baseId)) return;
  const shown = await dashboardsReadable(
    ctx.db,
    actor.bindings,
    dashboard.baseId,
    [dashboard.id],
  );
  if (!shown.has(dashboard.id)) throw new AppError("access_denied");
}

export const dashboardsRouter = t.router({
  list: asking({ asks: ["rows.read"] })
    .input(listDashboardsInputSchema)
    .query(({ ctx, input }) =>
      handle(ctx, async () => {
        const { bindings } = await guardBase(
          ctx,
          input.baseId,
          "rows.read",
          false,
          "tables",
        );
        const dashboards = await listDashboards(ctx.db, input.baseId);
        if (roleFor(bindings, "base", input.baseId)) return { dashboards };
        // Reached through its tables: only the dashboards whose every
        // widget reads a table they read (ADR 0131).
        const shown = await dashboardsReadable(
          ctx.db,
          bindings,
          input.baseId,
          dashboards.map((dashboard) => dashboard.id),
        );
        return {
          dashboards: dashboards.filter((dashboard) => shown.has(dashboard.id)),
        };
      }),
    ),
  get: asking({ asks: ["rows.read"] })
    .input(getDashboardInputSchema)
    .query(({ ctx, input }) =>
      handle(ctx, async () => {
        const actor = await authorize(ctx);
        const dashboard = await loadDashboard(ctx.db, input.dashboardId);
        await dashboardAccess(ctx, actor, dashboard);
        const board = await getDashboard(ctx.db, input.dashboardId);
        return {
          dashboard: board.dashboard,
          widgets: widgetsForReader(
            { userId: actor.user.id, bindings: actor.bindings },
            dashboard.baseId,
            board.widgets,
          ),
        };
      }),
    ),
  create: asking({ asks: ["dashboards.manage"] })
    .input(createDashboardInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const { user } = await guardBase(
          ctx,
          input.baseId,
          "dashboards.manage",
        );
        return createDashboard(ctx.db, user.id, input);
      }),
    ),
  update: asking({ asks: ["dashboards.manage"] })
    .input(updateDashboardInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const actor = await authorize(ctx);
        const dashboard = await loadDashboard(ctx.db, input.dashboardId);
        const { user } = await baseAccess(
          ctx,
          actor,
          dashboard.baseId,
          "dashboards.manage",
        );
        return updateDashboard(ctx.db, user.id, input);
      }),
    ),
  delete: asking({ asks: ["dashboards.manage"] })
    .input(deleteDashboardInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const actor = await authorize(ctx);
        const dashboard = await loadDashboard(ctx.db, input.dashboardId);
        const { user } = await baseAccess(
          ctx,
          actor,
          dashboard.baseId,
          "dashboards.manage",
        );
        await deleteDashboard(ctx.db, user.id, input.dashboardId);
        return { ok: true as const };
      }),
    ),
  upsertWidget: asking({ asks: ["dashboards.manage"] })
    .input(upsertWidgetInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const actor = await authorize(ctx);
        const dashboard = await loadDashboard(ctx.db, input.dashboardId);
        const { user } = await baseAccess(
          ctx,
          actor,
          dashboard.baseId,
          "dashboards.manage",
        );
        return upsertWidget(ctx.db, user.id, dashboard.baseId, input);
      }),
    ),
  deleteWidget: asking({ asks: ["dashboards.manage"] })
    .input(deleteWidgetInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const actor = await authorize(ctx);
        const dashboard = await loadDashboard(ctx.db, input.dashboardId);
        const { user } = await baseAccess(
          ctx,
          actor,
          dashboard.baseId,
          "dashboards.manage",
        );
        await deleteWidget(ctx.db, user.id, input.dashboardId, input.widgetId);
        return { ok: true as const };
      }),
    ),
  layout: asking({ asks: ["dashboards.manage"] })
    .input(layoutWidgetsInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const actor = await authorize(ctx);
        const dashboard = await loadDashboard(ctx.db, input.dashboardId);
        const { user } = await baseAccess(
          ctx,
          actor,
          dashboard.baseId,
          "dashboards.manage",
        );
        await layoutWidgets(ctx.db, user.id, input.dashboardId, input.widgets);
        return { ok: true as const };
      }),
    ),
  widgetData: asking({ asks: ["rows.read"] })
    .input(widgetDataInputSchema)
    .query(({ ctx, input }) =>
      handle(ctx, async () => {
        const actor = await authorize(ctx);
        const { user, bindings } = actor;
        const { dashboard, widgets } = await getDashboard(
          ctx.db,
          input.dashboardId,
        );
        await dashboardAccess(ctx, actor, dashboard);
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
              roleGrants(
                effectiveTableRole(bindings, tableId, dashboard.baseId),
                "rows.read",
              ),
          },
        );
      }),
    ),
});
