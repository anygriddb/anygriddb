import { Button, Spinner } from "@anygriddb/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLingui } from "@lingui/react/macro";
import { useState } from "react";
import { toast } from "sonner";
import { useErrorText } from "../../lib/errors";
import { trpc, useTRPC } from "../../lib/trpc";
import { ConfirmDialog } from "../shell/dialogs";

function date(value: string): string {
  return new Date(value).toLocaleString();
}

/** Who is signed in now, and ending their sessions (ADR 0042). */
export function SessionsTab() {
  const { t } = useLingui();
  const errorText = useErrorText();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const sessions = useQuery({
    ...api.admin.sessions.queryOptions(),
    refetchInterval: 30_000,
  });
  const [confirmAll, setConfirmAll] = useState(false);
  const settings = useQuery(api.admin.settings.queryOptions());
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
  const list = sessions.data?.sessions ?? [];
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {settings.data
            ? t`A session ends after ${{ idle: settings.data.sessionIdleMinutes }} minutes without activity, and after ${{ max: settings.data.sessionMaxHours }} hours in any case (set under Security). Ending one signs the person out at once.`
            : null}
        </p>
        <Button
          size="sm"
          variant="outline"
          disabled={!list.some((session) => !session.mine)}
          onClick={() => setConfirmAll(true)}
        >
          {t`Sign everyone else out`}
        </Button>
      </div>
      {sessions.isLoading ? <Spinner /> : null}
      <div className="overflow-x-auto rounded-sm border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted text-left text-xs">
            <tr>
              <th className="px-3 py-2">{t`Account`}</th>
              <th className="px-3 py-2">{t`Signed in`}</th>
              <th className="px-3 py-2">{t`Ends at the latest`}</th>
              <th className="px-3 py-2">
                <span className="sr-only">{t`Actions`}</span>
              </th>
            </tr>
          </thead>
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
                <td className="px-3 py-2 text-xs">{date(session.createdAt)}</td>
                <td className="px-3 py-2 text-xs">{date(session.expiresAt)}</td>
                <td className="px-3 py-2 text-right">
                  {session.mine ? (
                    <span className="text-xs text-muted-foreground">
                      {t`You`}
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
        </table>
      </div>
      {confirmAll ? (
        <ConfirmDialog
          open
          danger
          onOpenChange={(open) => !open && setConfirmAll(false)}
          title={t`Sign everyone else out?`}
          description={t`Every other session ends now, administrators' too. Your own stays open. API tokens keep working.`}
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
