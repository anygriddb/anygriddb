import { Button, Spinner } from "@anygriddb/ui";
import { Plus, ShieldAlert, Table2 } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { formatDate } from "../../lib/format";
import { useLocale } from "../../lib/i18n";
import { useCatalog, useSession } from "../../lib/session";
import { resolveShortcuts } from "../../lib/shortcut-list";
import { useShortcuts } from "../../lib/shortcuts";
import { useRoleLabel } from "../settings/base-settings";
import { NewBaseDialog } from "./new-base-dialog";
import { TrashedBases } from "./trashed-bases";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";

/**
 * The person's register: each base on its own ruled line, its tables as
 * the entries beneath it. The rules are the structure, not a decoration.
 */
export function HomePage() {
  const { t } = useLingui();
  const session = useSession();
  const catalog = useCatalog();
  const roleLabel = useRoleLabel();
  const [creating, setCreating] = useState(false);
  const bases = catalog.data ?? [];
  const { locale } = useLocale();
  const shortcuts = useShortcuts();
  const { recent } = resolveShortcuts(bases, shortcuts.data);
  return (
    <div className="flex-1 overflow-y-auto px-10 py-12">
      <div className="mx-auto max-w-4xl">
        <header className="flex items-end justify-between gap-4">
          <h1 className="text-[28px] leading-tight font-semibold">
            {t`Hello ${{ name: session.data?.displayName ?? "" }}`}
          </h1>
          {session.data?.canCreateBases === false ? null : (
            <Button onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" aria-hidden />
              {t`New base`}
            </Button>
          )}
        </header>
        {session.data?.canCreateBases === false ? (
          <p className="mt-4 max-w-prose text-sm text-muted-foreground">
            {t`On this instance, administrators create the bases: ask one for a base, or to be invited to one.`}
          </p>
        ) : null}
        {session.data &&
        session.data.canCreateBases &&
        !session.data.mfaEnrolled &&
        session.data.mfaForBases ? (
          <Link
            to="/settings"
            className="mt-4 flex items-center gap-3 rounded-sm border border-warning/40 bg-warning-surface p-4 text-sm"
          >
            <ShieldAlert className="h-5 w-5 text-warning" aria-hidden />
            {t`Enable a second factor to create and manage bases.`}
          </Link>
        ) : null}
        {recent.length > 0 ? (
          <section aria-label={t`Recently opened`} className="mt-10">
            <h2 className="border-b border-strong-border pb-2 text-xs font-medium text-muted-foreground">
              {t`Recently opened`}
            </h2>
            <ul>
              {recent.slice(0, 8).map(({ base, table, openedAt }) => (
                <li key={table.id} className="border-b border-rule">
                  <Link
                    to="/b/$baseId/t/$tableId/{-$viewId}"
                    params={{ baseId: base.id, tableId: table.id }}
                    className="flex min-h-10 items-center gap-4 text-sm hover:bg-muted"
                  >
                    <Table2
                      className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1 truncate font-medium">
                      {table.name}
                    </span>
                    <span className="hidden min-w-0 flex-1 truncate text-muted-foreground sm:block">
                      {base.name}
                    </span>
                    {table.external ? (
                      // A client's table: its name in the database.
                      <span className="hidden shrink-0 font-mono text-xs text-muted-foreground md:block">
                        {table.external.schema}.{table.external.name}
                      </span>
                    ) : null}
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {formatDate(
                        openedAt,
                        locale,
                        { format: "relative" },
                        true,
                      )}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {catalog.isLoading ? <Spinner className="mt-10" /> : null}
        {catalog.isSuccess && bases.length === 0 ? (
          // An empty desk invites: a base, or a database to connect.
          <div className="mt-10 border-t border-strong-border py-8 text-sm">
            <p className="text-base font-medium">{t`Nothing here yet.`}</p>
            <p className="mt-1 max-w-prose text-muted-foreground">
              {t`A base holds tables. A table is a real SQL table: one AnyGridDB keeps in PostgreSQL, or one of a database an administrator connected.`}
            </p>
            {session.data?.canCreateBases === false ? null : (
              <div className="mt-4 flex flex-wrap gap-2">
                <Button onClick={() => setCreating(true)}>
                  <Plus className="h-4 w-4" aria-hidden />
                  {t`New base`}
                </Button>
                {session.data?.isAdmin ? (
                  <Button variant="outline" asChild>
                    <Link to="/admin">{t`Connect a database`}</Link>
                  </Button>
                ) : null}
              </div>
            )}
          </div>
        ) : null}
        {bases.length > 0 ? (
          <section aria-label={t`Bases`} className="mt-10">
            <h2 className="border-b border-strong-border pb-2 text-xs font-medium text-muted-foreground">
              {t`Bases`}
            </h2>
            <ul>
              {bases.map((base) => (
                <li key={base.id} className="border-b border-rule py-5">
                  <div className="flex items-baseline gap-3">
                    <Link
                      to="/b/$baseId"
                      params={{ baseId: base.id }}
                      className="min-w-0 truncate text-base font-semibold hover:text-primary"
                    >
                      {base.name}
                    </Link>
                    <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                      {roleLabel(base.role)}
                    </span>
                    <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                      {plural(base.tables.length, {
                        one: `# table`,
                        other: `# tables`,
                      })}
                    </span>
                  </div>
                  {base.description ? (
                    <p className="mt-1 max-w-prose text-sm text-muted-foreground">
                      {base.description}
                    </p>
                  ) : null}
                  {base.tables.length > 0 ? (
                    <ul className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-sm">
                      {base.tables.map((table) => (
                        <li key={table.id}>
                          <Link
                            to="/b/$baseId/t/$tableId/{-$viewId}"
                            params={{ baseId: base.id, tableId: table.id }}
                            className="hover:text-primary hover:underline"
                          >
                            {table.name}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-2 text-sm text-muted-foreground">
                      {t`No tables yet`}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        <TrashedBases />
      </div>
      <NewBaseDialog
        open={creating}
        onOpenChange={setCreating}
        mfaEnrolled={
          (session.data?.mfaEnrolled ?? false) ||
          session.data?.mfaForBases === false
        }
      />
    </div>
  );
}
