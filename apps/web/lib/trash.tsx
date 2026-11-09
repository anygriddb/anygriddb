import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { toast } from "sonner";
import { trpc, useTRPC } from "./trpc";
import { useLingui } from "@lingui/react/macro";
import { useErrorText } from "../lib/errors";

export type TrashKind = "base" | "table" | "column" | "view";

/** Days an item waits in the trash; the API purges it afterwards. */
export const TRASH_DAYS = 30;

/** Restoring from the trash, and the "undo" toast shown after a delete. */
export function useTrashActions() {
  const { t } = useLingui();
  const errorText = useErrorText();
  const api = useTRPC();
  const queryClient = useQueryClient();

  const refresh = useCallback(
    () =>
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: api.catalog.list.queryKey(),
        }),
        queryClient.invalidateQueries({
          queryKey: api.catalog.trash.queryKey(),
        }),
        queryClient.invalidateQueries({
          queryKey: api.catalog.trashedBases.queryKey(),
        }),
        queryClient.invalidateQueries({
          queryKey: api.catalog.views.queryKey(),
        }),
      ]),
    [api, queryClient],
  );

  const restore = useCallback(
    async (kind: TrashKind, id: string) => {
      try {
        const restored = await trpc.catalog.restore.mutate({ kind, id });
        await refresh();
        toast.success(t`Restored from the trash`);
        return restored;
      } catch (cause) {
        toast.error(errorText(cause));
        return null;
      }
    },
    [refresh, t, errorText],
  );

  /** Confirms a delete and offers to take it back at once. */
  const trashed = useCallback(
    (message: string, kind: TrashKind, id: string) => {
      void refresh();
      toast.success(message, {
        description: t`It stays in the trash for ${{ days: TRASH_DAYS }} days.`,
        action: {
          label: t`Cancel`,
          onClick: () => void restore(kind, id),
        },
      });
    },
    [refresh, restore, t],
  );

  return { refresh, restore, trashed };
}
