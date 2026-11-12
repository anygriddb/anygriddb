import { cn } from "@anygriddb/ui";
import { useLingui } from "@lingui/react/macro";
import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import { useSession } from "../../lib/session";
import { NotebookPage } from "../shell/notebook-page";
import { locate, useAdminSections } from "./admin-sections";
import { ReleaseBanner } from "./release-banner";

/**
 * Administration: a first page of what needs action, then six sections
 * named by task, each page at an address of its own (ROADMAP #49). The
 * sections are links, so a page can be shared, reloaded, and gone back to.
 */
export function AdminShell() {
  const { t } = useLingui();
  const session = useSession();
  const sections = useAdminSections();
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  if (!session.data) return null;
  if (sections.length === 0) {
    return (
      <p className="p-6 text-sm text-muted-foreground">
        {t`This page is for instance administrators.`}
      </p>
    );
  }
  const here = locate(sections, pathname);
  // "page" for the page shown, "true" for the section or list it is in.
  const current = (to: string, within: boolean) =>
    pathname === to
      ? ("page" as const)
      : within
        ? ("true" as const)
        : undefined;
  const pages = here && here.section.pages.length > 1 ? here.section.pages : [];
  return (
    <NotebookPage
      width="wide"
      title={t`Administration`}
      description={t`People, security, connections, sources, trails, and the instance itself.`}
    >
      {session.data.isAdmin ? <ReleaseBanner /> : null}
      <nav
        aria-label={t`Administration`}
        className="mt-4 flex gap-1 overflow-x-auto border-b border-rule"
      >
        {sections.map((section) => {
          const active = here?.section.id === section.id;
          const Icon = section.icon;
          const first = section.pages[0];
          if (!first) return null;
          return (
            <Link
              key={section.id}
              to={first.to}
              activeOptions={{ exact: true, includeSearch: false }}
              aria-current={current(first.to, active)}
              className={cn(
                "-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm",
                active
                  ? "border-primary font-medium"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon className="h-4 w-4" aria-hidden />
              {section.label}
            </Link>
          );
        })}
      </nav>
      {here && pages.length > 0 ? (
        <nav
          aria-label={here.section.label}
          className="mt-3 flex w-fit flex-wrap gap-1 rounded-sm border border-border p-0.5"
        >
          {pages.map((page) => {
            const inside = here.page.to === page.to;
            return (
              <Link
                key={page.to}
                to={page.to}
                activeOptions={{ exact: true, includeSearch: false }}
                aria-current={current(page.to, inside)}
                className={cn(
                  "rounded-md px-3 py-1 text-sm",
                  inside
                    ? "bg-muted font-medium"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {page.label}
              </Link>
            );
          })}
        </nav>
      ) : null}
      <div className="mt-4">
        <Outlet />
      </div>
    </NotebookPage>
  );
}
