import { Button } from "@anygriddb/ui";
import {
  Code2,
  History,
  LayoutDashboard,
  Plus,
  Settings,
  Table2,
} from "lucide-react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { formatDate } from "../../lib/format";
import { useLocale } from "../../lib/i18n";
import { useCatalog } from "../../lib/session";
import { resolveShortcuts } from "../../lib/shortcut-list";
import { useShortcuts } from "../../lib/shortcuts";
import { trpc } from "../../lib/trpc";
import { canManage } from "../../lib/types";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { BlockedSourcesBanner } from "../table/source-reach";
import { NewTableDialog } from "./new-table-dialog";
import { EmptyState, NotebookPage } from "./notebook-page";
import { useInvalidateCatalog } from "./sidebar";

/**
 * Hub for one base: its tables, recent activity in that base, and the
 * destinations that used to live only in the sidebar menu.
 */
export function BaseHome({ baseId }: { baseId: string }) {
  const { t } = useLingui();
  const navigate = useNavigate();
  const catalog = useCatalog();
  const invalidate = useInvalidateCatalog();
  const { locale } = useLocale();
  const shortcuts = useShortcuts();
  const [creating, setCreating] = useState(false);
  const base = catalog.data?.find((item) => item.id === baseId);
  const manage = canManage(base?.role);
  const { recent } = resolveShortcuts(catalog.data ?? [], shortcuts.data);
  const recentHere = recent
    .filter((item) => item.base.id === baseId)
    .slice(0, 6);

  // Drawn inside `InBase`: the catalog is read, and holds the base.
  if (!base) return null;

  return (
    <NotebookPage
      title={base.name}
      description={
        base.description ||
        plural(base.tables.length, {
          one: `# table`,
          other: `# tables`,
        })
      }
      action={
        manage ? (
          <Button onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" aria-hidden />
            {t`New table`}
          </Button>
        ) : undefined
      }
    >
      <BlockedSourcesBanner
        tables={base.tables}
        locale={locale}
        surface="base"
      />
      <nav
        aria-label={t`Base`}
        className="mt-4 flex flex-wrap gap-x-5 gap-y-2 border-b border-rule pb-5 text-sm"
      >
        <Link
          to="/b/$baseId/dashboards"
          params={{ baseId }}
          className="inline-flex items-center gap-1.5 text-primary hover:underline"
        >
          <LayoutDashboard className="h-3.5 w-3.5" aria-hidden />
          {t`Dashboards`}
        </Link>
        <Link
          to="/b/$baseId/activity"
          params={{ baseId }}
          className="inline-flex items-center gap-1.5 text-primary hover:underline"
        >
          <History className="h-3.5 w-3.5" aria-hidden />
          {t`Activity`}
        </Link>
        <Link
          to="/b/$baseId/api"
          params={{ baseId }}
          className="inline-flex items-center gap-1.5 text-primary hover:underline"
        >
          <Code2 className="h-3.5 w-3.5" aria-hidden />
          {t`API`}
        </Link>
        <Link
          to="/b/$baseId/settings"
          params={{ baseId }}
          className="inline-flex items-center gap-1.5 text-primary hover:underline"
        >
          <Settings className="h-3.5 w-3.5" aria-hidden />
          {t`Settings and sharing`}
        </Link>
      </nav>

      {recentHere.length > 0 ? (
        <section aria-label={t`Recently opened`} className="mt-2">
          <h2 className="border-b border-strong-border pb-2 text-xs font-medium text-muted-foreground">
            {t`Recently opened`}
          </h2>
          <ul>
            {recentHere.map(({ table, openedAt }) => (
              <li key={table.id} className="border-b border-rule">
                <Link
                  to="/b/$baseId/t/$tableId/{-$viewId}"
                  params={{ baseId, tableId: table.id }}
                  className="flex min-h-10 items-center gap-4 text-sm hover:bg-muted"
                >
                  <Table2
                    className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1 truncate font-medium">
                    {table.name}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {formatDate(openedAt, locale, { format: "relative" }, true)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-label={t`Tables`} className="mt-8">
        <h2 className="border-b border-strong-border pb-2 text-xs font-medium text-muted-foreground">
          {t`Tables`}
        </h2>
        {base.tables.length === 0 ? (
          <EmptyState
            title={t`This base is empty.`}
            description={
              manage
                ? t`Add a table to start keeping rows, or connect a client database from administration.`
                : t`This base has no tables yet.`
            }
            action={
              manage ? (
                <Button onClick={() => setCreating(true)}>
                  <Plus className="h-4 w-4" aria-hidden />
                  {t`New table`}
                </Button>
              ) : undefined
            }
          />
        ) : (
          <ul>
            {base.tables.map((table) => (
              <li key={table.id} className="border-b border-rule">
                <Link
                  to="/b/$baseId/t/$tableId/{-$viewId}"
                  params={{ baseId, tableId: table.id }}
                  className="flex min-h-12 items-center gap-4 text-sm hover:bg-muted"
                >
                  <Table2
                    className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1 truncate font-medium">
                    {table.name}
                  </span>
                  {table.external ? (
                    <span className="hidden shrink-0 font-mono text-xs text-muted-foreground sm:block">
                      {table.external.schema}.{table.external.name}
                    </span>
                  ) : null}
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {plural(table.columns.length, {
                      one: `# field`,
                      other: `# fields`,
                    })}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <NewTableDialog
        open={creating}
        onOpenChange={setCreating}
        title={t`New table in ${{ name: base.name }}`}
        onCreate={async ({ name, columns }) => {
          const created = await trpc.catalog.createTable.mutate({
            baseId,
            name,
            columns,
          });
          await invalidate();
          void navigate({
            to: "/b/$baseId/t/$tableId/{-$viewId}",
            params: { baseId, tableId: created.id },
          });
        }}
      />
    </NotebookPage>
  );
}
