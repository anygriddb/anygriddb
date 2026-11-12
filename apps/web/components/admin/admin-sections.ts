import { useLingui } from "@lingui/react/macro";
import {
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
export type AdminPath =
  | "/admin"
  | "/admin/people/accounts"
  | "/admin/people/sessions"
  | "/admin/people/provisioning"
  | "/admin/security"
  | "/admin/connections"
  | "/admin/sources"
  | "/admin/sharing"
  | "/admin/sharing/access"
  | "/admin/trails"
  | "/admin/trails/sign-ins"
  | "/admin/instance"
  | "/admin/instance/health"
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
 * trails.
 */
export function useAdminSections(): AdminSection[] {
  const { t } = useLingui();
  const session = useSession();
  const isAdmin = session.data?.isAdmin === true;
  const isSupport = session.data?.isSupport === true;
  if (!isAdmin && !isSupport) return [];
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
      { to: "/admin/people/sessions", label: t`Sessions` },
      ...(isAdmin
        ? [
            {
              to: "/admin/people/provisioning",
              label: t`Provisioning`,
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
  if (!isAdmin) return [overview, people, trails];
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
      pages: [{ to: "/admin/connections", label: t`Connections` }],
    },
    {
      id: "sources",
      label: t`Sources`,
      icon: Database,
      pages: [{ to: "/admin/sources", label: t`Sources` }],
    },
    {
      id: "sharing",
      label: t`Sharing`,
      icon: Share2,
      pages: [
        { to: "/admin/sharing", label: t`Links and feeds` },
        { to: "/admin/sharing/access", label: t`Tokens and automations` },
      ],
    },
    trails,
    {
      id: "instance",
      label: t`Instance`,
      icon: Server,
      pages: [
        { to: "/admin/instance", label: t`Settings` },
        { to: "/admin/instance/health", label: t`Health` },
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
  const path = pathname.replace(/\/+$/, "") || "/";
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
