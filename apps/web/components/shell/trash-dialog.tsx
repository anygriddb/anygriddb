import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  Spinner,
} from "@anygriddb/ui";
import { useQuery } from "@tanstack/react-query";
import { RotateCcw, Sheet, Table2, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useTrackJob } from "../../lib/jobs";
import { useTrashActions } from "../../lib/trash";
import { trpc, useTRPC, type RouterOutputs } from "../../lib/trpc";
import { FieldIcon } from "../fields/field-meta";
import { VIEW_ICONS } from "../table/view-tabs";
import { ConfirmDialog } from "./dialogs";
import { useLingui } from "@lingui/react/macro";
import { useErrorText } from "../../lib/errors";

type Entry = RouterOutputs["catalog"]["trash"]["items"][number];

function EntryIcon({ entry }: { entry: Entry }) {
  if (entry.kind === "table") {
    return <Table2 className="h-4 w-4 shrink-0 opacity-70" aria-hidden />;
  }
  if (entry.kind === "column") {
    return (
      <FieldIcon
        fieldType={entry.type ?? "text"}
        className="h-4 w-4 shrink-0 opacity-70"
      />
    );
  }
  const Icon = VIEW_ICONS[entry.type ?? "grid"] ?? Sheet;
  return <Icon className="h-4 w-4 shrink-0 opacity-70" aria-hidden />;
}

/**
 * A base's trash: deleted tables, fields, and views, each restorable for
 * 30 days, and purged for good by an owner.
 */
export function TrashDialog(props: {
  baseId: string;
  baseName: string;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useLingui();
  const errorText = useErrorText();
  const api = useTRPC();
  const { restore, refresh } = useTrashActions();
  const trackJob = useTrackJob();
  // Deletes happen elsewhere, by anyone: read the trash afresh each time.
  const list = useQuery({
    ...api.catalog.trash.queryOptions({ baseId: props.baseId }),
    refetchOnMount: "always",
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [purging, setPurging] = useState<Entry | "all" | null>(null);
  const items = list.data?.items ?? [];

  function kindLabel(entry: Entry): string {
    switch (entry.kind) {
      case "table":
        return t`Table`;
      case "column":
        return t`Field of ${{ table: entry.tableName ?? "—" }}`;
      case "view":
        return t`View of ${{ table: entry.tableName ?? "—" }}`;
      default:
        return "";
    }
  }

  async function purge(target: Entry | "all") {
    let jobId: string | null;
    try {
      ({ jobId } = await trpc.catalog.purgeTrash.mutate({
        baseId: props.baseId,
        items:
          target === "all" ? undefined : [{ kind: target.kind, id: target.id }],
      }));
    } catch (cause) {
      toast.error(errorText(cause));
      return;
    }
    if (!jobId) return;
    await trackJob(jobId, {
      label: t`Deleting permanently…`,
      onDone: () => ({ message: t`Deleted permanently` }),
    });
    await refresh();
  }

  return (
    <Dialog open onOpenChange={props.onOpenChange}>
      <DialogContent
        wide
        title={t`Trash of ${{ name: props.baseName }}`}
        description={t`Deleted items stay here for 30 days with their data, then are deleted permanently.`}
      >
        {list.isLoading ? <Spinner /> : null}
        {list.isSuccess && items.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {t`The trash is empty.`}
          </p>
        ) : null}
        {items.length > 0 ? (
          <ul className="max-h-[55vh] divide-y divide-border overflow-y-auto rounded-md border border-border">
            {items.map((entry) => (
              <li
                key={`${entry.kind}:${entry.id}`}
                className="flex items-center gap-3 px-3 py-2 text-sm"
              >
                <EntryIcon entry={entry} />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{entry.name}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {kindLabel(entry)} ·{" "}
                    {t`deleted on ${{ date: new Date(entry.deletedAt).toLocaleDateString() }} by ${{ name: entry.deletedBy ?? t`a deleted account` }}`}{" "}
                    ·{" "}
                    {t`purged on ${{ date: new Date(entry.purgeAt).toLocaleDateString() }}`}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy !== null}
                  onClick={async () => {
                    setBusy(entry.id);
                    await restore(entry.kind, entry.id);
                    setBusy(null);
                  }}
                >
                  {busy === entry.id ? (
                    <Spinner />
                  ) : (
                    <RotateCcw className="h-4 w-4" aria-hidden />
                  )}
                  {t`Restore`}
                </Button>
                {list.data?.canPurge ? (
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={t`Delete ${{ name: entry.name }} permanently`}
                    onClick={() => setPurging(entry)}
                  >
                    <Trash2 className="h-4 w-4 text-danger" aria-hidden />
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
        <DialogFooter>
          {list.data?.canPurge && items.length > 0 ? (
            <Button variant="danger" onClick={() => setPurging("all")}>
              {t`Empty the trash`}
            </Button>
          ) : null}
          <Button onClick={() => props.onOpenChange(false)}>{t`Close`}</Button>
        </DialogFooter>
        {purging ? (
          <ConfirmDialog
            open
            danger
            onOpenChange={(open) => !open && setPurging(null)}
            title={
              purging === "all"
                ? t`Empty the trash?`
                : t`Delete “${{ name: purging.name }}” permanently?`
            }
            description={t`The data and attached files will be erased. The audit history is kept.`}
            confirmLabel={t`Delete permanently`}
            onConfirm={() => {
              void purge(purging);
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
