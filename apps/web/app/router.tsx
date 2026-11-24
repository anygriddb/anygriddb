/**
 * Every page of the app (ADR 0011). Paths and search parameters are typed:
 * a link to a page that does not exist, or a search value of the wrong
 * shape, is a compile error. Pages read their parameters here and hand
 * them to components as props, so components do not depend on the router.
 */
import { SIGN_ON_REFUSALS } from "@anygriddb/core";
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
import { lazy, useCallback, type ComponentType } from "react";
import { z } from "zod";
import { accountsSearchSchema } from "../components/admin/accounts-search";
import {
  logsSearchSchema,
  parseLogsSearch,
  type LogsSearch,
} from "../components/admin/logs-search";
import {
  changesSearchSchema,
  parseChangesSearch,
  parseSignInSearch,
  signInSearchSchema,
  type ChangesSearch,
  type SignInSearch,
} from "../components/admin/trail-search";
import { useRememberedSearch } from "../lib/remembered-search";
import { AuthPage } from "../components/auth/auth-page";
import { InBase } from "../components/shell/in-base";
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
const GroupsTab = page(() =>
  import("../components/admin/groups-tab").then((module) => module.GroupsTab),
);
const GroupAdminPage = page(() =>
  import("../components/admin/group-page").then(
    (module) => module.GroupAdminPage,
  ),
);
const ScimTab = page(() =>
  import("../components/admin/scim-tab").then((module) => module.ScimTab),
);
const ApiTokensTab = page(() =>
  import("../components/admin/api-tokens-tab").then(
    (module) => module.ApiTokensTab,
  ),
);
const OauthClientsTab = page(() =>
  import("../components/admin/oauth-clients-tab").then(
    (module) => module.OauthClientsTab,
  ),
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
const NotificationsTab = page(() =>
  import("../components/admin/notifications-tab").then(
    (module) => module.NotificationsTab,
  ),
);
const SourcesTab = page(() =>
  import("../components/admin/sources-tab").then((module) => module.SourcesTab),
);
const BasesTab = page(() =>
  import("../components/admin/bases-tab").then((module) => module.BasesTab),
);
const BaseAdminPage = page(() =>
  import("../components/admin/base-admin-page").then(
    (module) => module.BaseAdminPage,
  ),
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
const IdentityTab = page(() =>
  import("../components/admin/identity-tab").then(
    (module) => module.IdentityTab,
  ),
);
const HealthTab = page(() =>
  import("../components/admin/health-tab").then((module) => module.HealthTab),
);
const LogsTab = page(() =>
  import("../components/admin/logs-tab").then((module) => module.LogsTab),
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
const BaseActivity = page(() =>
  import("../components/shell/base-activity").then(
    (module) => module.BaseActivity,
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
const UnsubscribePage = page(() =>
  import("../components/public/unsubscribe-page").then(
    (module) => module.UnsubscribePage,
  ),
);
const PublicView = page(() =>
  import("../components/public/public-view").then(
    (module) => module.PublicView,
  ),
);
const PublicBase = page(() =>
  import("../components/public/public-base").then(
    (module) => module.PublicBase,
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
    /** Back from single sign-on refused: what the page says. */
    refused: z.enum(SIGN_ON_REFUSALS).optional().catch(undefined),
  }),
  component: function Login() {
    const { next, mfa, refused } = loginRoute.useSearch();
    return (
      <AuthPage
        mode="login"
        next={next}
        secondStep={mfa === 1}
        refused={refused}
      />
    );
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

/** A mail's unsubscribe link (ADR 0126): no session. */
const unsubscribeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/notify/unsubscribe/$token",
  component: function Unsubscribe() {
    const { token } = unsubscribeRoute.useParams();
    return <UnsubscribePage token={token} />;
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

const baseShareRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/s/b/$token",
  component: function BaseShare() {
    const { token } = baseShareRoute.useParams();
    return <PublicBase key={token} token={token} />;
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

const adminGroupRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "people/groups/$groupId",
  component: function Group() {
    const { groupId } = adminGroupRoute.useParams();
    return <GroupAdminPage groupId={groupId} />;
  },
});

const adminBaseRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "bases/$baseId",
  component: function Base() {
    const { baseId } = adminBaseRoute.useParams();
    return <BaseAdminPage baseId={baseId} />;
  },
});

const adminChangesRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "trails",
  validateSearch: changesSearchSchema,
  component: function Changes() {
    const url = adminChangesRoute.useSearch();
    const navigate = adminChangesRoute.useNavigate();
    const go = useCallback(
      (next: ChangesSearch) => {
        void navigate({ search: next, replace: true });
      },
      [navigate],
    );
    const search = useRememberedSearch(
      "ag.admin.changes",
      parseChangesSearch,
      url,
      go,
    );
    return (
      <ChangesTrail
        search={search}
        onSearch={(update) => {
          go(update(search));
        }}
      />
    );
  },
});

const adminSignInsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "trails/sign-ins",
  validateSearch: signInSearchSchema,
  component: function SignIns() {
    const url = adminSignInsRoute.useSearch();
    const navigate = adminSignInsRoute.useNavigate();
    const go = useCallback(
      (next: SignInSearch) => {
        void navigate({ search: next, replace: true });
      },
      [navigate],
    );
    const search = useRememberedSearch(
      "ag.admin.sign-ins",
      parseSignInSearch,
      url,
      go,
    );
    return (
      <SignInTrail
        search={search}
        onSearch={(update) => {
          go(update(search));
        }}
      />
    );
  },
});

const adminLogsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "instance/logs",
  validateSearch: logsSearchSchema,
  component: function Logs() {
    const url = adminLogsRoute.useSearch();
    const navigate = adminLogsRoute.useNavigate();
    const go = useCallback(
      (next: LogsSearch) => {
        void navigate({ search: next, replace: true });
      },
      [navigate],
    );
    const search = useRememberedSearch(
      "ag.admin.logs",
      parseLogsSearch,
      url,
      go,
    );
    return (
      <LogsTab
        search={search}
        onSearch={(update) => {
          go(update(search));
        }}
      />
    );
  },
});

const adminRoutes = [
  adminIndexRoute,
  adminPeopleRoute,
  adminAccountsRoute,
  adminAccountRoute,
  adminPage("people/groups", GroupsTab),
  adminGroupRoute,
  adminPage("people/sessions", SessionsTab),
  adminPage("people/provisioning", ScimTab),
  adminPage("security", SecurityPage),
  adminPage("connections", IntegrationsTab),
  adminPage("connections/notifications", NotificationsTab),
  adminPage("connections/api", ApiTokensTab),
  adminPage("connections/applications", OauthClientsTab),
  adminPage("sources", SourcesTab),
  adminPage("bases", BasesTab),
  adminBaseRoute,
  adminPage("sharing", OutboundTab),
  adminPage("sharing/access", AccessTab),
  adminChangesRoute,
  adminSignInsRoute,
  adminPage("instance", SettingsTab),
  adminPage("instance/identity", IdentityTab),
  adminPage("instance/health", HealthTab),
  adminLogsRoute,
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

const OauthConsentPage = page(() =>
  import("../components/oauth/consent-page").then(
    (module) => module.OauthConsentPage,
  ),
);

const oauthConsentRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/oauth/consent",
  validateSearch: (search: Record<string, unknown>) => ({
    client_id: typeof search.client_id === "string" ? search.client_id : "",
    redirect_uri:
      typeof search.redirect_uri === "string" ? search.redirect_uri : "",
    code_challenge:
      typeof search.code_challenge === "string" ? search.code_challenge : "",
    state: typeof search.state === "string" ? search.state : undefined,
  }),
  component: function OauthConsent() {
    const search = oauthConsentRoute.useSearch();
    return (
      <div className="flex-1 overflow-y-auto">
        <OauthConsentPage search={search} />
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
    // A column, so the page's own spinner stays in the middle.
    return (
      <InBase baseId={baseId}>
        <div className="flex flex-1 flex-col overflow-y-auto">
          <BaseHome baseId={baseId} />
        </div>
      </InBase>
    );
  },
});

const baseApiRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/b/$baseId/api",
  component: function BaseApi() {
    const { baseId } = baseApiRoute.useParams();
    return (
      <InBase baseId={baseId}>
        <div className="flex-1 overflow-y-auto">
          <ApiDocs baseId={baseId} />
        </div>
      </InBase>
    );
  },
});

const baseSettingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/b/$baseId/settings",
  component: function BaseSettingsPage() {
    const { baseId } = baseSettingsRoute.useParams();
    return (
      <InBase baseId={baseId}>
        <div className="flex-1 overflow-y-auto">
          <BaseSettings baseId={baseId} />
        </div>
      </InBase>
    );
  },
});

const baseActivityRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/b/$baseId/activity",
  component: function BaseActivityPage() {
    const { baseId } = baseActivityRoute.useParams();
    return (
      <InBase baseId={baseId}>
        <div className="flex-1 overflow-y-auto">
          <BaseActivity baseId={baseId} />
        </div>
      </InBase>
    );
  },
});

const dashboardsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/b/$baseId/dashboards",
  component: function Dashboards() {
    const { baseId } = dashboardsRoute.useParams();
    return (
      <InBase baseId={baseId}>
        <div className="flex-1 overflow-y-auto">
          <DashboardList baseId={baseId} />
        </div>
      </InBase>
    );
  },
});

const dashboardRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/b/$baseId/dashboards/$dashboardId",
  component: function Dashboard() {
    const { baseId, dashboardId } = dashboardRoute.useParams();
    return (
      <InBase baseId={baseId}>
        <DashboardBoard baseId={baseId} dashboardId={dashboardId} />
      </InBase>
    );
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
      <InBase baseId={baseId}>
        <TableWorkspace
          key={tableId}
          baseId={baseId}
          tableId={tableId}
          viewId={viewId}
          rowId={row}
        />
      </InBase>
    );
  },
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  signupRoute,
  invitationRoute,
  confirmSignupRoute,
  resetRoute,
  unsubscribeRoute,
  shareRoute,
  baseShareRoute,
  appRoute.addChildren([
    homeRoute,
    adminRoute.addChildren(adminRoutes),
    accountRoute,
    oauthConsentRoute,
    welcomeRoute,
    baseRoute,
    baseApiRoute,
    baseSettingsRoute,
    baseActivityRoute,
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
