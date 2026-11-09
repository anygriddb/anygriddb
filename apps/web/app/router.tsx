/**
 * Every page of the app (ADR 0011). Paths and search parameters are typed:
 * a link to a page that does not exist, or a search value of the wrong
 * shape, is a compile error. Pages read their parameters here and hand
 * them to components as props, so components do not depend on the router.
 */
import { Spinner } from "@anygriddb/ui";
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from "@tanstack/react-router";
import { lazy, type ComponentType } from "react";
import { z } from "zod";
import { AuthPage } from "../components/auth/auth-page";
import { NotFound } from "../components/shell/not-found";

/**
 * A page that loads its own code: a share link or the sign-in page does
 * not download the grid. The router shows `Pending` while it loads.
 */
function page<P extends object>(load: () => Promise<ComponentType<P>>) {
  return lazy(async () => ({ default: await load() }));
}

const AppShell = page(() =>
  import("../components/shell/app-shell").then((module) => module.AppShell),
);
const HomePage = page(() =>
  import("../components/shell/home-page").then((module) => module.HomePage),
);
const BaseHome = page(() =>
  import("../components/shell/base-home").then((module) => module.BaseHome),
);
const AdminPage = page(() =>
  import("../components/admin/admin-page").then((module) => module.AdminPage),
);
const AccountSettings = page(() =>
  import("../components/settings/account-settings").then(
    (module) => module.AccountSettings,
  ),
);
const ApiDocs = page(() =>
  import("../components/settings/api-docs").then((module) => module.ApiDocs),
);
const BaseSettings = page(() =>
  import("../components/settings/base-settings").then(
    (module) => module.BaseSettings,
  ),
);
const DashboardList = page(() =>
  import("../components/dashboards/dashboard-list").then(
    (module) => module.DashboardList,
  ),
);
const DashboardBoard = page(() =>
  import("../components/dashboards/dashboard-board").then(
    (module) => module.DashboardBoard,
  ),
);
const TableWorkspace = page(() =>
  import("../components/table/table-workspace").then(
    (module) => module.TableWorkspace,
  ),
);
const InvitationPage = page(() =>
  import("../components/public/invitation-page").then(
    (module) => module.InvitationPage,
  ),
);
const ResetPasswordPage = page(() =>
  import("../components/auth/reset-page").then(
    (module) => module.ResetPasswordPage,
  ),
);
const PublicView = page(() =>
  import("../components/public/public-view").then(
    (module) => module.PublicView,
  ),
);

function Pending() {
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <Spinner />
    </div>
  );
}

const rootRoute = createRootRoute({
  component: Outlet,
  notFoundComponent: NotFound,
});

/** Where to go after signing in: a path of this app, never another site. */
const nextSearch = z.object({
  next: z.string().optional().catch(undefined),
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  validateSearch: nextSearch.extend({
    /** Back from single sign-on with a second step to do (ADR 0043). */
    mfa: z.coerce.number().optional().catch(undefined),
  }),
  component: function Login() {
    const { next, mfa } = loginRoute.useSearch();
    return <AuthPage mode="login" next={next} secondStep={mfa === 1} />;
  },
});

const signupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/signup",
  validateSearch: nextSearch,
  component: function Signup() {
    const { next } = signupRoute.useSearch();
    return <AuthPage mode="signup" next={next} />;
  },
});

const invitationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/invite/$token",
  component: function Invitation() {
    const { token } = invitationRoute.useParams();
    return <InvitationPage token={token} />;
  },
});

const resetRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/reset/$token",
  component: function Reset() {
    const { token } = resetRoute.useParams();
    return <ResetPasswordPage token={token} />;
  },
});

const shareRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/s/$token",
  component: function Share() {
    const { token } = shareRoute.useParams();
    return <PublicView key={token} token={token} />;
  },
});

/** Pages behind a session, inside the sidebar shell. */
const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "app",
  component: function App() {
    return (
      <AppShell>
        <Outlet />
      </AppShell>
    );
  },
});

const homeRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/",
  component: HomePage,
});

const adminRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/admin",
  component: function Admin() {
    return (
      <div className="flex-1 overflow-y-auto">
        <AdminPage />
      </div>
    );
  },
});

const accountRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/settings",
  validateSearch: z.object({
    /** Set after sign-up: the page suggests a second factor. */
    welcome: z.boolean().optional().catch(undefined),
  }),
  component: function Account() {
    const { welcome } = accountRoute.useSearch();
    return (
      <div className="flex-1 overflow-y-auto">
        <AccountSettings welcome={welcome === true} />
      </div>
    );
  },
});

const baseRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/b/$baseId",
  component: function Base() {
    const { baseId } = baseRoute.useParams();
    return <BaseHome baseId={baseId} />;
  },
});

const baseApiRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/b/$baseId/api",
  component: function BaseApi() {
    const { baseId } = baseApiRoute.useParams();
    return (
      <div className="flex-1 overflow-y-auto">
        <ApiDocs baseId={baseId} />
      </div>
    );
  },
});

const baseSettingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/b/$baseId/settings",
  component: function BaseSettingsPage() {
    const { baseId } = baseSettingsRoute.useParams();
    return (
      <div className="flex-1 overflow-y-auto">
        <BaseSettings baseId={baseId} />
      </div>
    );
  },
});

const dashboardsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/b/$baseId/dashboards",
  component: function Dashboards() {
    const { baseId } = dashboardsRoute.useParams();
    return <DashboardList baseId={baseId} />;
  },
});

const dashboardRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/b/$baseId/dashboards/$dashboardId",
  component: function Dashboard() {
    const { baseId, dashboardId } = dashboardRoute.useParams();
    return <DashboardBoard baseId={baseId} dashboardId={dashboardId} />;
  },
});

const tableRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/b/$baseId/t/$tableId/{-$viewId}",
  validateSearch: z.object({
    /**
     * A record to open in the side panel, from a link or a notification.
     * A client's key reads as a number in `?row=7`, as emails write it.
     */
    row: z
      .union([z.string(), z.number().transform(String)])
      .optional()
      .catch(undefined),
  }),
  component: function Table() {
    const { baseId, tableId, viewId } = tableRoute.useParams();
    const { row } = tableRoute.useSearch();
    return (
      <TableWorkspace
        key={tableId}
        baseId={baseId}
        tableId={tableId}
        viewId={viewId}
        rowId={row}
      />
    );
  },
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  signupRoute,
  invitationRoute,
  resetRoute,
  shareRoute,
  appRoute.addChildren([
    homeRoute,
    adminRoute,
    accountRoute,
    baseRoute,
    baseApiRoute,
    baseSettingsRoute,
    dashboardsRoute,
    dashboardRoute,
    tableRoute,
  ]),
]);

export const router = createRouter({
  routeTree,
  defaultPendingComponent: Pending,
  // Every page reads its data through TanStack Query, which caches it.
  defaultPreload: false,
  scrollRestoration: false,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
