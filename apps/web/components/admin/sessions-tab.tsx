import { Button, Spinner } from "@anygriddb/ui";
import { plural } from "@lingui/core/macro";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLingui } from "@lingui/react/macro";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useErrorText } from "../../lib/errors";
import { useSession } from "../../lib/session";
import { trpc, useTRPC } from "../../lib/trpc";
import { sortRows } from "../../lib/sort-rows";
import { useWhen } from "../../lib/i18n";
import { useColumnSort } from "../sort-header";
import { ConfirmDialog } from "../shell/dialogs";
import { LoadFailed } from "../shell/load-failed";
import { AdminPager, AdminTable, AdminTableHead } from "./admin-list";
import {
  lastAdminPage,
  useAdminPage,
  useAdminPageSize,
} from "./admin-page-size";

/** Who is signed in now, and ending their sessions (ADR 0042). */
export function SessionsTab() {
  const { t } = useLingui();
  const date = useWhen().instant;
  const errorText = useErrorText();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const [pageSize, setPageSize] = useAdminPageSize();
  const { page, setPage, offset, limit } = useAdminPage(pageSize);
  const sessions = useQuery({
    ...api.admin.sessions.queryOptions({ limit, offset }),
    refetchInterval: 30_000,
    placeholderData: (previous) => previous,
  });
  const [confirmAll, setConfirmAll] = useState(false);
  const viewer = useSession().data;
  const isAdmin = viewer?.isAdmin === true;
  // Signing everyone out is an administrator's and support's (ADR 0054);
  // support's spares the accounts that hold a role of Administration.
  const signsAllOut = isAdmin || viewer?.isSupport === true;
  const readsSettings = isAdmin || viewer?.isAuditor === true;
  const settings = useQuery({
    ...api.admin.settings.queryOptions(),
    enabled: readsSettings,
  });
  const columns = useColumnSort<"account" | "signedIn" | "ends">();
  async function run(action: () => Promise<unknown>, done: string) {
    try {
      await action();
      await queryClient.invalidateQueries({
        queryKey: api.admin.sessions.queryKey(),
      });
      toast.success(done);
    } catch (cause) {
      toast.error(errorText(cause));
    }
  }
  const total = sessions.data?.total ?? 0;
  const loaded = sessions.data !== undefined;
  // The last rows of the last page ended: its neighbour takes over.
  const lastPage = lastAdminPage(total, pageSize);
  useEffect(() => {
    if (loaded && page > lastPage) setPage(lastPage);
  }, [loaded, page, lastPage, setPage]);
  // A refresh that fails keeps the list already read.
  if (sessions.isError && !loaded) {
    return (
      <LoadFailed
        error={sessions.error}
        onRetry={() => void sessions.refetch()}
      />
    );
  }
  const list = sortRows(
    sessions.data?.sessions ?? [],
    columns.sort,
    (session, key) => {
      if (key === "account") return session.displayName;
      if (key === "signedIn") return session.createdAt;
      return session.expiresAt;
    },
    (session) => session.id,
  );
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-1">
          {total > 0 ? (
            <p className="text-sm font-medium">
              {plural(total, {
                one: `# open session`,
                other: `# open sessions`,
              })}
            </p>
          ) : null}
          <p className="text-sm text-muted-foreground">
            {settings.data
              ? t`A session ends after ${{ idle: settings.data.sessionIdleMinutes }} minutes without activity, and after ${{ max: settings.data.sessionMaxHours }} hours in any case (set under Security). Ending one signs the person out at once.`
              : null}
          </p>
          <p className="text-sm text-muted-foreground">
            {t`This is who is signed in on the instance. Who has a table open is shown as “People here” on that table, not here.`}
          </p>
        </div>
        {signsAllOut ? (
          <Button
            size="sm"
            variant="outline"
            disabled={!list.some((session) => !session.mine)}
            onClick={() => setConfirmAll(true)}
          >
            {t`Sign everyone else out`}
          </Button>
        ) : null}
      </div>
      {sessions.isLoading ? <Spinner /> : null}
      {loaded && total === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t`No session open right now.`}
        </p>
      ) : null}
      {list.length > 0 ? (
        <>
          <AdminTable>
            <AdminTableHead>
              <tr>
                {columns.header("account", t`Account`, "px-3 py-2")}
                {columns.header("signedIn", t`Signed in`, "px-3 py-2")}
                {columns.header("ends", t`Ends at the latest`, "px-3 py-2")}
                <th className="px-3 py-2">
                  <span className="sr-only">{t`Actions`}</span>
                </th>
              </tr>
            </AdminTableHead>
            <tbody>
              {list.map((session) => (
                <tr key={session.id} className="border-t border-border">
                  <td className="px-3 py-2">
                    <p className="font-medium">
                      {session.displayName}
                      {session.isAdmin ? (
                        <span className="ml-2 text-xs font-normal text-muted-foreground">
                          {t`Administrator`}
                        </span>
                      ) : null}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {session.email}
                    </p>
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {date(session.createdAt)}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {date(session.expiresAt)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {session.mine ? (
                      <span className="text-xs text-muted-foreground">
                        {t`You`}
                      </span>
                    ) : !isAdmin && session.holdsRole ? (
                      <span className="text-xs text-muted-foreground">
                        {t`Administrators only`}
                      </span>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          void run(
                            () =>
                              trpc.admin.endSession.mutate({
                                sessionId: session.id,
                              }),
                            t`Session ended`,
                          )
                        }
                      >
                        {t`End`}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </AdminTable>
          <AdminPager
            total={total}
            offset={offset}
            pageSize={pageSize}
            onPageSize={setPageSize}
            onPrev={() => setPage(page - 1)}
            onNext={() => setPage(page + 1)}
          />
        </>
      ) : null}
      {confirmAll ? (
        <ConfirmDialog
          open
          danger
          onOpenChange={(open) => !open && setConfirmAll(false)}
          title={t`Sign everyone else out?`}
          description={
            isAdmin
              ? t`Every other session ends now, administrators' too. Your own stays open. API tokens keep working.`
              : t`Every other session ends now, but those of accounts that hold a role of Administration. Your own stays open. API tokens keep working.`
          }
          confirmLabel={t`Sign out`}
          onConfirm={() =>
            run(
              () => trpc.admin.endOtherSessions.mutate(),
              t`Everyone else is signed out`,
            )
          }
        />
      ) : null}
    </div>
  );
}
