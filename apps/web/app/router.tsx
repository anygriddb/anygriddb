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
  Navigate,
  Outlet,
  useRouter,
  type RouteComponent,
} from "@tanstack/react-router";
import { lazy, type ComponentType } from "react";
import { z } from "zod";
import { accountsSearchSchema } from "../components/admin/accounts-search";
import { AuthPage } from "../components/auth/auth-page";
import { NotFound } from "../components/shell/not-found";
import { PageCrashed } from "../components/shell/page-crashed";
import { reportFailure } from "../lib/report-failure";

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
const WelcomePage = page(() =>
  import("../components/shell/welcome-page").then(
    (module) => module.WelcomePage,
  ),
);
const BaseHome = page(() =>
  import("../components/shell/base-home").then((module) => module.BaseHome),
);
const AdminShell = page(() =>
  import("../components/admin/admin-shell").then((module) => module.AdminShell),
);
const AdminOverview = page(() =>
  import("../components/admin/admin-overview").then(
    (module) => module.AdminOverview,
  ),
);
const AccountsTab = page(() =>
  import("../components/admin/accounts-tab").then(
    (module) => module.AccountsTab,
  ),
);
const AccountAdminPage = page(() =>
  import("../components/admin/account-page").then(
    (module) => module.AccountAdminPage,
  ),
);
const SessionsTab = page(() =>
  import("../components/admin/sessions-tab").then(
    (module) => module.SessionsTab,
  ),
);
const ScimTab = page(() =>
  import("../components/admin/scim-tab").then((module) => module.ScimTab),
);
const SecurityPage = page(() =>
  import("../components/admin/security-tab").then(
    (module) => module.SecurityPage,
  ),
);
const IntegrationsTab = page(() =>
  import("../components/admin/integrations-tab").then(
    (module) => module.IntegrationsTab,
  ),
);
const SourcesTab = page(() =>
  import("../components/admin/sources-tab").then((module) => module.SourcesTab),
);
const AccessTab = page(() =>
  import("../components/admin/access-tab").then((module) => module.AccessTab),
);
const OutboundTab = page(() =>
  import("../components/admin/outbound-tab").then(
    (module) => module.OutboundTab,
  ),
);
const ChangesTrail = page(() =>
  import("../components/admin/trails").then((module) => module.ChangesTrail),
);
const SignInTrail = page(() =>
  import("../components/admin/sign-in-trail").then(
    (module) => module.SignInTrail,
  ),
);
const SettingsTab = page(() =>
  import("../components/admin/settings-tab").then(
    (module) => module.SettingsTab,
  ),
);
const HealthTab = page(() =>
  import("../components/admin/health-tab").then((module) => module.HealthTab),
);
const SupportTab = page(() =>
  import("../components/admin/support-tab").then((module) => module.SupportTab),
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
const ConfirmSignupPage = page(() =>
  import("../components/auth/confirm-signup-page").then(
    (module) => module.ConfirmSignupPage,
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

/** The link a sign-up mails to prove its address (ADR 0058). */
const confirmSignupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/signup/$token",
  component: function ConfirmSignup() {
    const { token } = confirmSignupRoute.useParams();
    return <ConfirmSignupPage token={token} />;
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

/**
 * Administration: a first page, then six sections named by task, every
 * page at an address of its own (ROADMAP #49).
 */
const adminRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/admin",
  component: function Admin() {
    return (
      <div className="flex-1 overflow-y-auto">
        <AdminShell />
      </div>
    );
  },
});

function adminPage<const Path extends string>(
  path: Path,
  component: RouteComponent,
) {
  return createRoute({ getParentRoute: () => adminRoute, path, component });
}

const adminIndexRoute = adminPage("/", AdminOverview);

/** A section's address opens its first page. */
const adminPeopleRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "people",
  component: function People() {
    return <Navigate to="/admin/people/accounts" replace />;
  },
});

const adminAccountsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "people/accounts",
  validateSearch: accountsSearchSchema,
  component: function Accounts() {
    const search = adminAccountsRoute.useSearch();
    const navigate = adminAccountsRoute.useNavigate();
    const router = useRouter();
    return (
      <AccountsTab
        search={search}
        onSearch={(update) => {
          // A search typed just before leaving the list does not bring
          // the person back to it.
          if (router.state.location.pathname !== "/admin/people/accounts") {
            return;
          }
          void navigate({ search: update, replace: true });
        }}
      />
    );
  },
});

const adminAccountRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "people/accounts/$userId",
  component: function Account() {
    const { userId } = adminAccountRoute.useParams();
    return <AccountAdminPage userId={userId} />;
  },
});

const adminRoutes = [
  adminIndexRoute,
  adminPeopleRoute,
  adminAccountsRoute,
  adminAccountRoute,
  adminPage("people/sessions", SessionsTab),
  adminPage("people/provisioning", ScimTab),
  adminPage("security", SecurityPage),
  adminPage("connections", IntegrationsTab),
  adminPage("sources", SourcesTab),
  adminPage("sharing", OutboundTab),
  adminPage("sharing/access", AccessTab),
  adminPage("trails", ChangesTrail),
  adminPage("trails/sign-ins", SignInTrail),
  adminPage("instance", SettingsTab),
  adminPage("instance/health", HealthTab),
  adminPage("instance/support", SupportTab),
];

const accountRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/settings",
  component: function Account() {
    return (
      <div className="flex-1 overflow-y-auto">
        <AccountSettings />
      </div>
    );
  },
});

/** A new account's first page: protect it, then bring data. */
const welcomeRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/welcome",
  component: WelcomePage,
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
  confirmSignupRoute,
  resetRoute,
  shareRoute,
  appRoute.addChildren([
    homeRoute,
    adminRoute.addChildren(adminRoutes),
    accountRoute,
    welcomeRoute,
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
  defaultErrorComponent: PageCrashed,
  // The operator learns of a page that could not be drawn.
  defaultOnCatch: (error) => {
    reportFailure("render", error);
  },
  // Every page reads its data through TanStack Query, which caches it.
  defaultPreload: false,
  scrollRestoration: false,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
