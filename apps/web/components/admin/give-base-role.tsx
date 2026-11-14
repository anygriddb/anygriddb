import type { Role } from "@anygriddb/core";
import { useLingui } from "@lingui/react/macro";
import { useState, type ReactNode } from "react";
import { useSession } from "../../lib/session";
import { trpc } from "../../lib/trpc";
import { PromptDialog } from "../shell/dialogs";

/**
 * Gives an account a role on a base from Administration. A role the
 * administrator gives themselves lets them into the base (ADR 0074): it
 * asks a reason first, and the page says that the base's owners are
 * told. Resolves to false when the administrator gives up; a
 * refusal from the server is thrown.
 */
export function useGiveBaseRole(): {
  give: (input: {
    userId: string;
    baseId: string;
    role: Role;
  }) => Promise<boolean>;
  dialogs: ReactNode;
} {
  const { t } = useLingui();
  const session = useSession();
  const [asking, setAsking] = useState<{
    answer: (reason: string | null) => void;
  } | null>(null);

  async function give(input: { userId: string; baseId: string; role: Role }) {
    if (input.userId !== session.data?.id) {
      await trpc.admin.setBaseRole.mutate(input);
      return true;
    }
    const reason = await new Promise<string | null>((answer) =>
      setAsking({ answer }),
    );
    if (!reason) return false;
    await trpc.admin.setBaseRole.mutate({ ...input, reason });
    return true;
  }

  const dialogs = (
    <PromptDialog
      open={asking !== null}
      onOpenChange={(open) => {
        if (open) return;
        asking?.answer(null);
        setAsking(null);
      }}
      title={t`Give yourself this role?`}
      label={t`Reason`}
      submitLabel={t`Give myself the role`}
      multiline
      onSubmit={(reason) => {
        asking?.answer(reason);
        setAsking(null);
      }}
    >
      <p className="text-sm text-muted-foreground">
        {t`You administer the instance, and this role lets you into the base. Its owners are told, in the app and by email, with your name and this reason, and it is written to the change trail.`}
      </p>
    </PromptDialog>
  );
  return { give, dialogs };
}
