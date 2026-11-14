import { rowsRouter } from "./rows-router.js";
import { authRouter, sessionRouter } from "./auth-router.js";
import { catalogRouter } from "./catalog-router.js";
import { adminRouter } from "./admin-router.js";
import { automationsRouter } from "./automations-router.js";
import { dashboardsRouter } from "./dashboards-router.js";
import { jobsRouter } from "./jobs-router.js";
import { notificationsRouter } from "./notifications-router.js";
import { shareRouter } from "./share-router.js";
import { shortcutsRouter } from "./shortcuts-router.js";
import { t } from "./init.js";

export const appRouter = t.router({
  session: sessionRouter,
  auth: authRouter,
  catalog: catalogRouter,
  rows: rowsRouter,
  share: shareRouter,
  notifications: notificationsRouter,
  automations: automationsRouter,
  admin: adminRouter,
  jobs: jobsRouter,
  dashboards: dashboardsRouter,
  shortcuts: shortcutsRouter,
});

export type AppRouter = typeof appRouter;
