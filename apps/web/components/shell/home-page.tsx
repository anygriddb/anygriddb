import { Button, Spinner } from "@anygriddb/ui";
import { Plus, ShieldAlert } from "lucide-react";
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
    <div className="flex-1 overflow-y-auto px-8 py-10">
      <div className="mx-auto max-w-4xl">
        <header className="flex items-end justify-between gap-4 border-b border-foreground pb-3">
          <h1 className="text-2xl font-semibold">
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
            className="mt-4 flex items-center gap-3 rounded-sm border border-amber-500/40 bg-amber-500/10 p-4 text-sm"
          >
            <ShieldAlert className="h-5 w-5 text-amber-600" aria-hidden />
            {t`Enable a second factor to create and manage bases.`}
          </Link>
        ) : null}
        {recent.length > 0 ? (
          <section aria-label={t`Recently opened`} className="mt-8">
            <h2 className="text-sm font-medium text-muted-foreground">
              {t`Recently opened`}
            </h2>
            <ul className="mt-2 border-t border-border">
              {recent.slice(0, 8).map(({ base, table, openedAt }) => (
                <li key={table.id} className="border-b border-border">
                  <Link
                    to="/b/$baseId/t/$tableId/{-$viewId}"
                    params={{ baseId: base.id, tableId: table.id }}
                    className="flex items-baseline gap-4 py-2 text-sm hover:text-primary"
                  >
                    <span className="min-w-0 flex-1 truncate font-medium">
                      {table.name}
                    </span>
                    <span className="hidden min-w-0 flex-1 truncate text-muted-foreground sm:block">
                      {base.name}
                    </span>
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
          <div className="mt-10 border-t border-border text-sm text-muted-foreground">
            <p className="border-b border-border py-3">
              {t`Create your first base to get started.`}
            </p>
            <div aria-hidden className="h-11 border-b border-border" />
            <div aria-hidden className="h-11 border-b border-border" />
          </div>
        ) : null}
        {bases.length > 0 ? (
          <section aria-label={t`Bases`} className="mt-8">
            <h2 className="text-sm font-medium text-muted-foreground">
              {t`Bases`}
            </h2>
            <ul className="mt-2 border-t border-border">
              {bases.map((base) => (
                <li key={base.id} className="border-b border-border py-4">
                  <div className="flex items-baseline gap-4">
                    <Link
                      to="/b/$baseId"
                      params={{ baseId: base.id }}
                      className="min-w-0 truncate text-lg font-semibold hover:text-primary"
                    >
                      {base.name}
                    </Link>
                    <span className="ml-auto flex shrink-0 gap-4 text-xs text-muted-foreground">
                      <span>
                        {plural(base.tables.length, {
                          one: `# table`,
                          other: `# tables`,
                        })}
                      </span>
                      <span>{roleLabel(base.role)}</span>
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
