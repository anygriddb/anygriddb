import { applyViewConfigPatch } from "@anygriddb/core";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { useErrorText } from "../../lib/errors";
import { trpc, useTRPC } from "../../lib/trpc";
import type { Role, ViewConfig, ViewItem } from "../../lib/types";
import { canEditView } from "./table-rights";
import { saveQueue, withoutSaved } from "./view-patch";
import type { ViewPatch } from "./view-toolbar";

/**
 * A view's settings as the page shows them: what is stored, under what the
 * person changed and is not stored yet. A change shows at once and is
 * saved behind it; on a view the person may not change, it stays theirs
 * for as long as the page is open.
 */
export function useViewSettings(input: {
  tableId: string;
  view: ViewItem | undefined;
  role: Role | null;
}) {
  const { tableId, view, role } = input;
  const api = useTRPC();
  const queryClient = useQueryClient();
  const errorText = useErrorText();

  // Unsaved changes to the view shown; another view starts clean.
  const [local, setLocal] = useState<ViewPatch>({});
  const [patchedView, setPatchedView] = useState(view?.id);
  if (patchedView !== view?.id) {
    setPatchedView(view?.id);
    setLocal({});
  }
  const config: ViewConfig = useMemo(
    () => applyViewConfigPatch((view?.config ?? {}) as never, local as never),
    [view?.config, local],
  );
  const editable = canEditView(view, role, true);

  // A view's saves go one after another, and a setting is shown as kept
  // locally until its own save is stored: a quicker second change of the
  // same setting is neither undone nor saved first.
  const [queueSave] = useState(saveQueue);
  const patch = useCallback(
    async (change: ViewPatch) => {
      setLocal((current) => ({ ...current, ...change }));
      if (!view || !editable) return;
      const viewId = view.id;
      await queueSave(async () => {
        try {
          await trpc.catalog.updateView.mutate({ viewId, patch: change });
          await queryClient.invalidateQueries({
            queryKey: api.catalog.views.queryKey({ tableId }),
          });
          setLocal((current) => withoutSaved(current, change));
        } catch (cause) {
          toast.error(errorText(cause));
        }
      });
    },
    [view, editable, queryClient, api, tableId, errorText, queueSave],
  );

  return { config, local, editable, patch };
}
