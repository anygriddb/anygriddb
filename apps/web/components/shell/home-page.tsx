import { Button, Spinner } from "@anygriddb/ui";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Plus, ShieldAlert, Table2 } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { formatAgo, formatDate } from "../../lib/format";
import { useLocale } from "../../lib/i18n";
import { useCatalog, useSession } from "../../lib/session";
import { resolveShortcuts } from "../../lib/shortcut-list";
import { useShortcuts } from "../../lib/shortcuts";
import { useTRPC, type RouterOutputs } from "../../lib/trpc";
import { useRoleLabel } from "../settings/role-label";
import { LoadFailed } from "./load-failed";
import { NewBaseDialog } from "./new-base-dialog";
import { EmptyState, NotebookPage } from "./notebook-page";
import {
  NOTIFICATION_ICONS,
  useDescribeNotification,
  useOpenNotification,
} from "./notification-items";
import { PendingInvitations } from "./pending-invitations";
import { TrashedBases } from "./trashed-bases";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";

/** How many tables "Pick up where you left off" lists. */
const RECENT_SHOWN = 6;
/** How many unread notifications "For you" lists. */
const WAITING_SHOWN = 5;

type Recent = ReturnType<typeof resolveShortcuts>["recent"][number];
type Activity = RouterOutputs["catalog"]["activity"][number];

/** A section of the page, under its ruled heading. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="mt-10">
      <h2 className="border-b border-strong-border pb-2 text-xs font-medium text-muted-foreground">
        {title}
      </h2>
      {children}
    </section>
  );
}

/**
 * What is waiting for the person: their unread notifications, the newest
 * first, each opening the row or page it is about.
 */
function ForYou() {
  const { t } = useLingui();
  const { locale } = useLocale();
  const api = useTRPC();
  const session = useSession();
  const describe = useDescribeNotification();
  const openNotification = useOpenNotification();
  const list = useQuery({
    ...api.notifications.list.queryOptions({
      limit: WAITING_SHOWN,
      unreadOnly: true,
    }),
    enabled: Boolean(session.data),
    placeholderData: keepPreviousData,
  });
  if (!list.data) return null;
  const items = list.data.notifications;
  const more = list.data.unread - items.length;
  return (
    <Section title={t`For you`}>
      {items.length === 0 ? (
        <p className="border-b border-rule py-3 text-sm text-muted-foreground">
          {t`Nothing is waiting for you.`}
        </p>
      ) : (
        <ul>
          {items.map((item) => {
            const Icon = NOTIFICATION_ICONS[item.kind];
            return (
              <li key={item.id} className="border-b border-rule">
                <button
                  type="button"
                  onClick={() => void openNotification(item)}
                  className="flex min-h-10 w-full items-center gap-3 py-2 text-left text-sm hover:bg-muted"
                >
                  <Icon className="h-4 w-4 shrink-0 text-primary" aria-hidden />
                  <span className="min-w-0 flex-1">{describe(item)}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {formatAgo(item.createdAt, locale)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {more > 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">
          {plural(more, {
            one: `# more in your notifications`,
            other: `# more in your notifications`,
          })}
        </p>
      ) : null}
    </Section>
  );
}

/**
 * The tables the person opened last, each with what it holds and its last
 * change: how many rows they see, when, and by whom. A client's table says
 * where its rows live instead.
 */
function PickUp({ recent }: { recent: readonly Recent[] }) {
  const { t } = useLingui();
  const { locale } = useLocale();
  const api = useTRPC();
  const session = useSession();
  const shown = recent.slice(0, RECENT_SHOWN);
  const tableIds = shown.map(({ table }) => table.id);
  const activity = useQuery({
    ...api.catalog.activity.queryOptions({ tableIds }),
    enabled: tableIds.length > 0,
    placeholderData: keepPreviousData,
  });
  const byTable = new Map<string, Activity>(
    (activity.data ?? []).map((entry) => [entry.tableId, entry]),
  );
  const rowsText = (entry: Activity | undefined) => {
    if (!entry?.rows) return "";
    const { total, estimated } = entry.rows;
    return estimated
      ? plural(total, { one: `about # row`, other: `about # rows` })
      : plural(total, { one: `# row`, other: `# rows` });
  };
  const changeText = ({ table }: Recent, entry: Activity | undefined) => {
    if (table.external) {
      return table.external.synced?.at
        ? t`Copied on ${{ date: formatDate(table.external.synced.at, locale, undefined, true) }}`
        : t`Live in ${{ source: table.external.source?.name ?? "—" }}`;
    }
    if (!entry?.changed) return "";
    const when = formatAgo(entry.changed.at, locale);
    return entry.changed.by.id === session.data?.id
      ? t`Changed ${when} by you`
      : t`Changed ${when} by ${{ name: entry.changed.by.name }}`;
  };
  return (
    <Section title={t`Pick up where you left off`}>
      <ul>
        {shown.map((item) => {
          const entry = byTable.get(item.table.id);
          return (
            <li key={item.table.id} className="border-b border-rule">
              <Link
                to="/b/$baseId/t/$tableId/{-$viewId}"
                params={{ baseId: item.base.id, tableId: item.table.id }}
                className="grid min-h-10 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 py-2 text-sm hover:bg-muted md:grid-cols-[minmax(0,1.1fr)_minmax(0,0.8fr)_8rem_minmax(0,1.5fr)]"
              >
                <span className="flex min-w-0 items-center gap-2.5">
                  <Table2
                    className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                    aria-hidden
                  />
                  <span className="truncate font-medium">
                    {item.table.name}
                  </span>
                </span>
                <span className="hidden truncate text-muted-foreground md:block">
                  {item.base.name}
                </span>
                <span className="text-right text-xs text-muted-foreground">
                  {rowsText(entry)}
                </span>
                <span className="col-span-2 truncate pl-6 text-xs text-muted-foreground md:col-span-1 md:pl-0">
                  {changeText(item, entry)}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

/**
 * What the person finds on signing in: what is waiting for them, the
 * tables to pick up with what changed in them, then their bases, each on
 * its own ruled line. The rules are the structure, not a decoration.
 */
export function HomePage() {
  const { t } = useLingui();
  const session = useSession();
  const catalog = useCatalog();
  const roleLabel = useRoleLabel();
  const [creating, setCreating] = useState(false);
  const bases = catalog.data ?? [];
  const shortcuts = useShortcuts();
  const { recent } = resolveShortcuts(bases, shortcuts.data);
  if (!catalog.data) {
    if (catalog.isError) {
      return (
        <LoadFailed
          error={catalog.error}
          onRetry={() => void catalog.refetch()}
        />
      );
    }
    return (
      <div className="flex flex-1 items-center justify-center">
        <Spinner />
      </div>
    );
  }
  return (
    <div className="flex-1 overflow-y-auto">
      <NotebookPage
        title={t`Hello ${{ name: session.data?.displayName ?? "" }}`}
        description={
          bases.length > 0
            ? t`What is waiting for you, and what changed in your tables.`
            : undefined
        }
        action={
          // An empty desk has its own invitation below: one button, not two.
          session.data?.canCreateBases === false ||
          bases.length === 0 ? null : (
            <Button onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" aria-hidden />
              {t`New base`}
            </Button>
          )
        }
      >
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
        <PendingInvitations />
        {bases.length > 0 ? <ForYou /> : null}
        {recent.length > 0 ? <PickUp recent={recent} /> : null}
        {bases.length === 0 ? (
          // An empty desk invites: a base, or a database to connect.
          <EmptyState
            className="mt-10 border-t border-strong-border border-b-0"
            title={t`Nothing here yet.`}
            description={t`A base holds tables. A table is a real SQL table: one AnyGridDB keeps in PostgreSQL, or one of a database an administrator connected.`}
            action={
              session.data?.canCreateBases === false ? undefined : (
                <div className="flex flex-wrap gap-2">
                  <Button onClick={() => setCreating(true)}>
                    <Plus className="h-4 w-4" aria-hidden />
                    {t`New base`}
                  </Button>
                  {session.data?.isAdmin ? (
                    <Button variant="outline" asChild>
                      <Link to="/admin/sources">{t`Connect a database`}</Link>
                    </Button>
                  ) : null}
                </div>
              )
            }
          />
        ) : null}
        {bases.length > 0 ? (
          <Section title={t`Bases`}>
            <ul>
              {bases.map((base) => (
                <li key={base.id} className="border-b border-rule">
                  <Link
                    to="/b/$baseId"
                    params={{ baseId: base.id }}
                    className="flex min-h-12 flex-col justify-center py-2.5 hover:bg-muted"
                  >
                    <span className="flex items-baseline gap-3">
                      <span className="min-w-0 truncate text-base font-semibold">
                        {base.name}
                      </span>
                      <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                        {roleLabel(base.role)}
                      </span>
                      <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                        {base.tables.length === 0
                          ? t`No tables yet`
                          : plural(base.tables.length, {
                              one: `# table`,
                              other: `# tables`,
                            })}
                      </span>
                    </span>
                    {base.description ? (
                      <span className="mt-0.5 max-w-prose truncate text-sm text-muted-foreground">
                        {base.description}
                      </span>
                    ) : null}
                  </Link>
                </li>
              ))}
            </ul>
          </Section>
        ) : null}
        <TrashedBases />
      </NotebookPage>
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
