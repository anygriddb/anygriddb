import { trimEndRun } from "@anygriddb/core";
import { useLingui } from "@lingui/react/macro";
import {
  Boxes,
  Database,
  LayoutDashboard,
  LockKeyhole,
  Plug,
  ScrollText,
  Server,
  Share2,
  Users,
  type LucideIcon,
} from "lucide-react";
import { useSession } from "../../lib/session";

/** Every page of Administration that has an address of its own. */
type AdminPath =
  | "/admin"
  | "/admin/people/accounts"
  | "/admin/people/groups"
  | "/admin/people/roles"
  | "/admin/people/sessions"
  | "/admin/people/provisioning"
  | "/admin/security"
  | "/admin/connections"
  | "/admin/connections/notifications"
  | "/admin/connections/api"
  | "/admin/connections/applications"
  | "/admin/sources"
  | "/admin/bases"
  | "/admin/sharing"
  | "/admin/sharing/access"
  | "/admin/trails"
  | "/admin/trails/sign-ins"
  | "/admin/instance"
  | "/admin/instance/identity"
  | "/admin/instance/health"
  | "/admin/instance/limits"
  | "/admin/instance/logs"
  | "/admin/instance/support";

export type AdminPage = { to: AdminPath; label: string };

export type AdminSection = {
  id: string;
  label: string;
  icon: LucideIcon;
  /** The section's pages, the first one opened from the section. */
  pages: AdminPage[];
};

/**
 * Administration in sections named by task (ROADMAP #49): the people, how
 * they sign in, what the instance connects to, the client databases, the
 * trails, and the instance itself, after a first page of what needs action.
 * Support (ADR 0054) sees the first page, accounts and sessions, and the
 * trails. An account manager (ADR 0126) sees the first page, the accounts,
 * the groups and the sessions; a source manager, the sources. An auditor
 * (ADR 0071) sees every page, as an administrator does, and changes none.
 */
export function useAdminSections(): AdminSection[] {
  const { t } = useLingui();
  const session = useSession();
  // What an administrator reads, an auditor reads too.
  const seesAll =
    session.data?.isAdmin === true || session.data?.isAuditor === true;
  const isSupport = session.data?.isSupport === true;
  const roles = session.data?.instanceRoles ?? [];
  const managesAccounts = roles.includes("account_manager");
  const managesSources = roles.includes("source_manager");
  const helpsPeople = isSupport || managesAccounts;
  if (!seesAll && !helpsPeople && !managesSources) return [];
  const overview: AdminSection = {
    id: "overview",
    label: t`Overview`,
    icon: LayoutDashboard,
    pages: [{ to: "/admin", label: t`Overview` }],
  };
  const people: AdminSection = {
    id: "people",
    label: t`People`,
    icon: Users,
    pages: [
      { to: "/admin/people/accounts", label: t`Accounts` },
      ...(seesAll || managesAccounts
        ? ([{ to: "/admin/people/groups", label: t`Groups` }] as const)
        : []),
      ...(seesAll
        ? ([{ to: "/admin/people/roles", label: t`Roles` }] as const)
        : []),
      { to: "/admin/people/sessions", label: t`Sessions` },
      ...(seesAll
        ? [
            {
              to: "/admin/people/provisioning",
              label: t`Provisioning (SCIM)`,
            } as const,
          ]
        : []),
    ],
  };
  const trails: AdminSection = {
    id: "trails",
    label: t`Trails`,
    icon: ScrollText,
    pages: [
      { to: "/admin/trails", label: t`Changes` },
      { to: "/admin/trails/sign-ins", label: t`Sign-ins` },
    ],
  };
  const sources: AdminSection = {
    id: "sources",
    label: t`Sources`,
    icon: Database,
    pages: [{ to: "/admin/sources", label: t`Sources` }],
  };
  if (!seesAll) {
    return [
      ...(helpsPeople ? [overview, people] : []),
      ...(managesSources ? [sources] : []),
      ...(isSupport ? [trails] : []),
    ];
  }
  return [
    overview,
    people,
    {
      id: "security",
      label: t`Security`,
      icon: LockKeyhole,
      pages: [{ to: "/admin/security", label: t`Security` }],
    },
    {
      id: "connections",
      label: t`Connections`,
      icon: Plug,
      pages: [
        { to: "/admin/connections", label: t`Connections` },
        { to: "/admin/connections/notifications", label: t`Notifications` },
        { to: "/admin/connections/api", label: t`Administration API` },
        { to: "/admin/connections/applications", label: t`Applications` },
      ],
    },
    sources,
    {
      id: "bases",
      label: t`Bases`,
      icon: Boxes,
      pages: [{ to: "/admin/bases", label: t`Bases` }],
    },
    {
      id: "sharing",
      label: t`Sharing`,
      icon: Share2,
      pages: [
        { to: "/admin/sharing", label: t`Access` },
        { to: "/admin/sharing/access", label: t`Webhooks and automations` },
      ],
    },
    trails,
    {
      id: "instance",
      label: t`Instance`,
      icon: Server,
      pages: [
        { to: "/admin/instance", label: t`Settings` },
        { to: "/admin/instance/identity", label: t`Name and logo` },
        { to: "/admin/instance/health", label: t`Health` },
        { to: "/admin/instance/limits", label: t`Limits and usage` },
        { to: "/admin/instance/logs", label: t`Logs` },
        { to: "/admin/instance/support", label: t`Support` },
      ],
    },
  ];
}

/**
 * The section and page an address belongs to: the page whose address is
 * the longest start of it, so an account's page belongs to Accounts.
 */
export function locate(
  sections: readonly AdminSection[],
  pathname: string,
): { section: AdminSection; page: AdminPage } | null {
  const path = trimEndRun(pathname, "/") || "/";
  let found: { section: AdminSection; page: AdminPage } | null = null;
  for (const section of sections) {
    for (const page of section.pages) {
      const matches =
        page.to === "/admin"
          ? path === "/admin"
          : path === page.to || path.startsWith(`${page.to}/`);
      if (matches && (!found || page.to.length > found.page.to.length)) {
        found = { section, page };
      }
    }
  }
  return found;
}
