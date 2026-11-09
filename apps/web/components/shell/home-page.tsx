import { Button, Spinner } from "@anygriddb/ui";
import { Clock, Database, Plus, ShieldAlert, Table2 } from "lucide-react";
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
    <div className="flex-1 overflow-y-auto p-8">
      <div className="mx-auto max-w-5xl">
        <div className="mb-6 flex items-center justify-between">
          <h1 className="text-2xl font-semibold">
            {t`Hello ${{ name: session.data?.displayName ?? "" }}`}
          </h1>
          {session.data?.canCreateBases === false ? null : (
            <Button onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" aria-hidden />
              {t`New base`}
            </Button>
          )}
        </div>
        {session.data?.canCreateBases === false ? (
          <p className="mb-6 text-sm text-muted-foreground">
            {t`On this instance, administrators create the bases: ask one for a base, or to be invited to one.`}
          </p>
        ) : null}
        {session.data &&
        session.data.canCreateBases &&
        !session.data.mfaEnrolled &&
        session.data.mfaForBases ? (
          <Link
            to="/settings"
            className="mb-6 flex items-center gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm"
          >
            <ShieldAlert className="h-5 w-5 text-amber-600" aria-hidden />
            {t`Enable a second factor to create and manage bases.`}
          </Link>
        ) : null}
        {recent.length > 0 ? (
          <section aria-label={t`Recently opened`} className="mb-8">
            <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-muted-foreground">
              <Clock className="h-4 w-4" aria-hidden />
              {t`Recently opened`}
            </h2>
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-2">
              {recent.slice(0, 8).map(({ base, table, openedAt }) => (
                <li key={table.id}>
                  <Link
                    to="/b/$baseId/t/$tableId/{-$viewId}"
                    params={{ baseId: base.id, tableId: table.id }}
                    className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm hover:border-strong-border"
                  >
                    <Table2
                      className="h-4 w-4 shrink-0 opacity-70"
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">
                        {table.name}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {base.name} ·{" "}
                        {formatDate(
                          openedAt,
                          locale,
                          { format: "relative" },
                          true,
                        )}
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {catalog.isLoading ? <Spinner /> : null}
        {catalog.isSuccess && bases.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border p-10 text-center text-muted-foreground">
            <Database className="mx-auto mb-3 h-8 w-8 opacity-50" aria-hidden />
            <p>{t`Create your first base to get started.`}</p>
          </div>
        ) : null}
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-4">
          {bases.map((base) => (
            <li key={base.id}>
              <Link
                to="/b/$baseId"
                params={{ baseId: base.id }}
                className="flex h-full flex-col gap-2 rounded-xl border border-border bg-card p-4 shadow-sm hover:border-strong-border"
              >
                <span className="flex items-center gap-2 font-medium">
                  <Database className="h-4 w-4 text-primary" aria-hidden />
                  {base.name}
                </span>
                {base.description ? (
                  <span className="line-clamp-2 text-sm text-muted-foreground">
                    {base.description}
                  </span>
                ) : null}
                <span className="mt-auto text-xs text-muted-foreground">
                  {plural(base.tables.length, {
                    one: `# table`,
                    other: `# tables`,
                  })}{" "}
                  · {roleLabel(base.role)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
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
