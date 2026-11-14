import { cn } from "@anygriddb/ui";
import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation, useParams } from "@tanstack/react-router";
import { LayoutDashboard } from "lucide-react";
import { useTRPC } from "../../lib/trpc";

/**
 * A base's dashboards in the sidebar, beside its tables: a line that
 * opens their list, under every base that is unfolded, and each
 * dashboard by name under the base the page shows. The names are read
 * for that base alone, so the sidebar asks for one list, never for one
 * per base.
 */
export function SidebarDashboards({
  baseId,
  current,
}: {
  baseId: string;
  /** Whether the page shown belongs to this base. */
  current: boolean;
}) {
  const { t } = useLingui();
  const api = useTRPC();
  const params = useParams({ strict: false });
  const pathname = useLocation({ select: (location) => location.pathname });
  const list = useQuery({
    ...api.dashboards.list.queryOptions({ baseId }),
    enabled: current,
  });
  const listPath = `/b/${baseId}/dashboards`;
  const shown = current ? params.dashboardId : undefined;
  const dashboards = current ? (list.data?.dashboards ?? []) : [];

  return (
    <li>
      <div
        className={cn(
          "flex items-center gap-1.5 rounded-md px-1.5 py-1 text-sm hover:bg-muted",
          pathname === listPath && "bg-accent text-accent-foreground",
        )}
      >
        <LayoutDashboard
          className="h-3.5 w-3.5 shrink-0 opacity-70"
          aria-hidden
        />
        <Link
          to="/b/$baseId/dashboards"
          params={{ baseId }}
          className="min-w-0 flex-1 truncate"
        >
          {t`Dashboards`}
        </Link>
      </div>
      {dashboards.length > 0 ? (
        <ul
          aria-label={t`Dashboards`}
          className="ml-4 flex flex-col gap-0.5 border-l border-border pl-2"
        >
          {dashboards.map((dashboard) => (
            <li
              key={dashboard.id}
              className={cn(
                "rounded-md px-1.5 py-1 text-sm hover:bg-muted",
                shown === dashboard.id && "bg-accent text-accent-foreground",
              )}
            >
              <Link
                to="/b/$baseId/dashboards/$dashboardId"
                params={{ baseId, dashboardId: dashboard.id }}
                className="block truncate"
              >
                {dashboard.name}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}
