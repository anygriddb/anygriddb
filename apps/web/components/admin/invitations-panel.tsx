import { Button, Spinner } from "@anygriddb/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLingui } from "@lingui/react/macro";
import { useState } from "react";
import { toast } from "sonner";
import { useErrorText } from "../../lib/errors";
import { trpc, useTRPC } from "../../lib/trpc";
import { sortRows } from "../../lib/sort-rows";
import { useWhen } from "../../lib/i18n";
import { useColumnSort } from "../sort-header";
import { ConfirmDialog } from "../shell/dialogs";
import { RuledSection } from "../shell/notebook-page";
import { AdminPager, AdminTable, AdminTableHead } from "./admin-list";
import { useAdminPage, useAdminPageSize } from "./admin-page-size";

/**
 * Pending base invitations, next to Accounts (ROADMAP #20). An
 * administrator may withdraw or resend; inviting into a base stays with
 * its owners.
 */
export function InvitationsPanel() {
  const { t } = useLingui();
  const date = useWhen().instant;
  const errorText = useErrorText();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const [withdraw, setWithdraw] = useState<{
    id: string;
    email: string;
  } | null>(null);
  const invitations = useQuery(api.admin.invitations.queryOptions());
  const [pageSize, setPageSize] = useAdminPageSize();
  const { page, setPage, offset, limit } = useAdminPage(pageSize);
  const columns = useColumnSort<"email" | "base" | "role" | "by" | "expires">();
  const all = invitations.data?.invitations ?? [];
  const pageItems = sortRows(
    all.slice(offset, offset + limit),
    columns.sort,
    (invitation, key) => {
      if (key === "email") return invitation.email;
      if (key === "base") return invitation.baseName;
      if (key === "role") return invitation.role;
      if (key === "by") return invitation.invitedByName;
      return invitation.expiresAt;
    },
    (invitation) => invitation.id,
  );
  async function run(action: () => Promise<unknown>, done?: string) {
    try {
      await action();
      await queryClient.invalidateQueries({
        queryKey: api.admin.invitations.queryKey(),
      });
      if (done) toast.success(done);
    } catch (cause) {
      toast.error(errorText(cause));
    }
  }
  return (
    <>
      <RuledSection
        title={t`Pending invitations`}
        description={t`A base's owners invite people. You can withdraw an invitation sent by mistake, or send the link again.`}
      >
        {invitations.isLoading ? <Spinner /> : null}
        {invitations.data?.invitations.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t`No invitation is waiting. One shows here from the moment someone is invited to a base until they answer it or it expires.`}
          </p>
        ) : (
          <>
            <AdminTable tableClassName="text-xs">
              <AdminTableHead>
                <tr>
                  {columns.header("email", t`Email`, "px-2 py-1.5")}
                  {columns.header("base", t`Base`, "px-2 py-1.5")}
                  {columns.header("role", t`Role`, "px-2 py-1.5")}
                  {columns.header("by", t`Invited by`, "px-2 py-1.5")}
                  {columns.header("expires", t`Expires`, "px-2 py-1.5")}
                  <th className="px-2 py-1.5">
                    <span className="sr-only">{t`Actions`}</span>
                  </th>
                </tr>
              </AdminTableHead>
              <tbody>
                {pageItems.map((invitation) => (
                  <tr key={invitation.id} className="border-t border-border">
                    <td className="px-2 py-1.5">{invitation.email}</td>
                    <td className="px-2 py-1.5">{invitation.baseName}</td>
                    <td className="px-2 py-1.5">{invitation.role}</td>
                    <td className="px-2 py-1.5">
                      {invitation.invitedByName ?? "—"}
                    </td>
                    <td className="px-2 py-1.5 whitespace-nowrap">
                      {date(invitation.expiresAt)}
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            void run(async () => {
                              const result =
                                await trpc.admin.resendInvitation.mutate({
                                  invitationId: invitation.id,
                                });
                              if (result.mailed) {
                                toast.success(
                                  t`Invitation sent again to ${{ email: invitation.email }}`,
                                );
                              } else if (result.link) {
                                await navigator.clipboard.writeText(
                                  result.link,
                                );
                                toast.success(
                                  t`Link copied — email is not set up`,
                                );
                              }
                            })
                          }
                        >
                          {t`Resend`}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            setWithdraw({
                              id: invitation.id,
                              email: invitation.email,
                            })
                          }
                        >
                          {t`Withdraw`}
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </AdminTable>
            <AdminPager
              total={all.length}
              offset={offset}
              pageSize={pageSize}
              onPageSize={setPageSize}
              onPrev={() => setPage(page - 1)}
              onNext={() => setPage(page + 1)}
            />
          </>
        )}
      </RuledSection>
      {withdraw ? (
        <ConfirmDialog
          open
          danger
          onOpenChange={(open) => !open && setWithdraw(null)}
          title={t`Withdraw the invitation to ${{ email: withdraw.email }}?`}
          description={t`The link stops working. The base's owners can invite this person again.`}
          confirmLabel={t`Withdraw`}
          onConfirm={() =>
            run(
              () =>
                trpc.admin.withdrawInvitation.mutate({
                  invitationId: withdraw.id,
                }),
              t`Invitation withdrawn`,
            )
          }
        />
      ) : null}
    </>
  );
}
