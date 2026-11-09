import { Button } from "@anygriddb/ui";
import { useQuery } from "@tanstack/react-query";
import { Database, RotateCcw, Trash2 } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { useTrackJob } from "../../lib/jobs";
import { useTrashActions } from "../../lib/trash";
import { trpc, useTRPC, type RouterOutputs } from "../../lib/trpc";
import { ConfirmDialog } from "./dialogs";
import { useLingui } from "@lingui/react/macro";
import { useErrorText } from "../../lib/errors";

type Entry = RouterOutputs["catalog"]["trashedBases"]["items"][number];

/** Bases the caller deleted or managed, restorable for 30 days. */
export function TrashedBases() {
  const { t } = useLingui();
  const errorText = useErrorText();
  const api = useTRPC();
  const navigate = useNavigate();
  const { restore, refresh } = useTrashActions();
  const trackJob = useTrackJob();
  const list = useQuery({
    ...api.catalog.trashedBases.queryOptions(),
    refetchOnMount: "always",
  });
  const [purging, setPurging] = useState<Entry | null>(null);
  const items = list.data?.items ?? [];
  if (items.length === 0) return null;

  async function purge(entry: Entry) {
    let jobId: string | null;
    try {
      ({ jobId } = await trpc.catalog.purgeTrash.mutate({
        baseId: entry.id,
        items: [{ kind: "base", id: entry.id }],
      }));
    } catch (cause) {
      toast.error(errorText(cause));
      return;
    }
    if (!jobId) return;
    await trackJob(jobId, {
      label: t`Deleting ${{ name: entry.name }} permanently…`,
      onDone: () => ({ message: t`Base deleted permanently` }),
    });
    await refresh();
  }

  return (
    <section className="mt-10">
      <h2 className="mb-1 text-sm font-semibold text-muted-foreground">
        {t`Deleted bases`}
      </h2>
      <p className="mb-3 text-xs text-muted-foreground">
        {t`They stay for 30 days with their data, then are deleted permanently.`}
      </p>
      <ul className="divide-y divide-border rounded-xl border border-border bg-card">
        {items.map((entry) => (
          <li
            key={entry.id}
            className="flex items-center gap-3 px-4 py-2 text-sm"
          >
            <Database className="h-4 w-4 shrink-0 opacity-60" aria-hidden />
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{entry.name}</div>
              <div className="text-xs text-muted-foreground">
                {t`deleted on ${{ date: new Date(entry.deletedAt).toLocaleDateString() }} by ${{ name: entry.deletedBy ?? t`a deleted account` }}`}{" "}
                ·{" "}
                {t`purged on ${{ date: new Date(entry.purgeAt).toLocaleDateString() }}`}
              </div>
            </div>
            <Button
              size="sm"
              variant="ghost"
              onClick={async () => {
                const restored = await restore("base", entry.id);
                if (restored)
                  void navigate({
                    to: "/b/$baseId",
                    params: { baseId: entry.id },
                  });
              }}
            >
              <RotateCcw className="h-4 w-4" aria-hidden />
              {t`Restore`}
            </Button>
            <Button
              size="icon"
              variant="ghost"
              aria-label={t`Delete ${{ name: entry.name }} permanently`}
              onClick={() => setPurging(entry)}
            >
              <Trash2 className="h-4 w-4 text-danger" aria-hidden />
            </Button>
          </li>
        ))}
      </ul>
      {purging ? (
        <ConfirmDialog
          open
          danger
          onOpenChange={(open) => !open && setPurging(null)}
          title={t`Delete “${{ name: purging.name }}” permanently?`}
          description={t`The data and attached files will be erased. The audit history is kept.`}
          confirmLabel={t`Delete permanently`}
          onConfirm={() => {
            void purge(purging);
          }}
        />
      ) : null}
    </section>
  );
}
