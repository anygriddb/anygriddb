import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { toast } from "sonner";
import { useErrorText } from "./errors";
import { trpc, useTRPC } from "./trpc";

export type PinTarget = { baseId: string } | { tableId: string };

/** The person's pins and recent tables, and a way to pin or unpin. */
export function useShortcuts() {
  const api = useTRPC();
  const queryClient = useQueryClient();
  const errorText = useErrorText();
  const list = useQuery(api.shortcuts.list.queryOptions());
  const pinnedBases = new Set(list.data?.pinnedBases ?? []);
  const pinnedTables = new Set(list.data?.pinnedTables ?? []);
  const setPinned = useCallback(
    async (target: PinTarget, pinned: boolean) => {
      try {
        await trpc.shortcuts.pin.mutate({ ...target, pinned });
        await queryClient.invalidateQueries({
          queryKey: api.shortcuts.list.queryKey(),
        });
      } catch (cause) {
        toast.error(errorText(cause));
      }
    },
    [api, queryClient, errorText],
  );
  return { data: list.data, pinnedBases, pinnedTables, setPinned };
}
