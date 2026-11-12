import { Button } from "@anygriddb/ui";
import { useLingui } from "@lingui/react/macro";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { useErrorText } from "../../lib/errors";
import { trpc, useTRPC } from "../../lib/trpc";
import type { Role } from "../../lib/types";
import { useRoleLabel } from "../settings/role-label";
import { useInvalidateCatalog } from "./sidebar";

type Invitation = {
  id: string;
  role: Role;
  baseName: string;
  invitedBy: string | null;
};

/**
 * The invitations sent to this account's address, answered from the home
 * page: accepting gives the role at once, with no link to look for.
 */
export function PendingInvitations() {
  const { t } = useLingui();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const invalidateCatalog = useInvalidateCatalog();
  const errorText = useErrorText();
  const roleLabel = useRoleLabel();
  const pending = useQuery(api.auth.pendingInvitations.queryOptions());
  const [answering, setAnswering] = useState<string | null>(null);
  const invitations = pending.data?.invitations ?? [];
  if (invitations.length === 0) return null;

  async function answer(invitation: Invitation, accept: boolean) {
    setAnswering(invitation.id);
    try {
      await trpc.auth.answerInvitation.mutate({
        invitationId: invitation.id,
        accept,
      });
      toast.success(
        accept
          ? t`You joined ${{ base: invitation.baseName }}`
          : t`Invitation declined`,
      );
      await queryClient.invalidateQueries({
        queryKey: api.auth.pendingInvitations.queryKey(),
      });
      if (accept) await invalidateCatalog();
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      setAnswering(null);
    }
  }

  return (
    <section aria-label={t`Invitations`} className="mt-10">
      <h2 className="border-b border-strong-border pb-2 text-xs font-medium text-muted-foreground">
        {t`Invitations`}
      </h2>
      <ul>
        {invitations.map((invitation) => {
          const base = invitation.baseName;
          const role = roleLabel(invitation.role);
          return (
            <li
              key={invitation.id}
              className="flex flex-wrap items-center gap-3 border-b border-rule py-3 text-sm"
            >
              <p className="min-w-0 flex-1">
                {invitation.invitedBy
                  ? t`${{ inviter: invitation.invitedBy }} invites you to ${{ base }} as ${{ role }}`
                  : t`You are invited to ${{ base }} as ${{ role }}`}
              </p>
              <Button
                size="sm"
                disabled={answering === invitation.id}
                onClick={() => void answer(invitation, true)}
              >
                {t`Accept`}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={answering === invitation.id}
                onClick={() => void answer(invitation, false)}
              >
                {t`Decline`}
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
