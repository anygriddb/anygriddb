import { Button, Input, Label } from "@anygriddb/ui";
import { useQuery } from "@tanstack/react-query";
import { Database, RotateCcw, Trash2 } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { useTrackJob } from "../../lib/jobs";
import { useTrashActions, useTrashDays } from "../../lib/trash";
import { useSession } from "../../lib/session";
import { trpc, useTRPC, type RouterOutputs } from "../../lib/trpc";
import { ConfirmDialog } from "./dialogs";
import { useLingui } from "@lingui/react/macro";
import { useErrorText } from "../../lib/errors";
import { useWhen } from "../../lib/i18n";

type Entry = RouterOutputs["catalog"]["trashedBases"]["items"][number];

/** Bases the caller deleted or managed, restorable while the trash keeps them. */
export function TrashedBases() {
  const { t } = useLingui();
  const when = useWhen();
  const days = useTrashDays();
  const errorText = useErrorText();
  const api = useTRPC();
  const navigate = useNavigate();
  const { restore, refresh } = useTrashActions();
  const trackJob = useTrackJob();
  const list = useQuery({
    ...api.catalog.trashedBases.queryOptions(),
    refetchOnMount: "always",
  });
  const session = useSession();
  const [purging, setPurging] = useState<Entry | null>(null);
  const [schemaName, setSchemaName] = useState("");
  const items = list.data?.items ?? [];
  if (items.length === 0) return null;

  async function purge(entry: Entry, dropSchema?: string) {
    let jobId: string | null;
    try {
      ({ jobId } = await trpc.catalog.purgeTrash.mutate({
        baseId: entry.id,
        items: [{ kind: "base", id: entry.id }],
        ...(dropSchema ? { dropSchema } : {}),
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
    <section aria-label={t`Deleted bases`} className="mt-10">
      <h2 className="border-b border-strong-border pb-2 text-xs font-medium text-muted-foreground">
        {t`Deleted bases`}
      </h2>
      <p className="mt-2 text-xs text-muted-foreground">
        {t`They stay for ${{ days }} days with their data, then are deleted permanently.`}
      </p>
      <ul>
        {items.map((entry) => (
          <li
            key={entry.id}
            className="flex items-center gap-3 border-b border-rule py-3 text-sm"
          >
            <Database className="h-4 w-4 shrink-0 opacity-60" aria-hidden />
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{entry.name}</div>
              <div className="text-xs text-muted-foreground">
                {t`deleted on ${{ date: when.day(entry.deletedAt) }} by ${{ name: entry.deletedBy ?? t`a deleted account` }}`}{" "}
                · {t`purged on ${{ date: when.day(entry.purgeAt) }}`}
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
              onClick={() => {
                setSchemaName("");
                setPurging(entry);
              }}
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
          description={
            purging.homeSchema
              ? t`The base is erased here. The audit history is kept. The schema ${{ schema: purging.homeSchema }} stays in the external source.`
              : t`The data and attached files will be erased. The audit history is kept.`
          }
          confirmLabel={t`Delete permanently`}
          onConfirm={() => {
            const typed = schemaName.trim();
            if (typed && typed !== purging.homeSchema) {
              toast.error(
                t`That is not the schema's name, so the base was not deleted.`,
              );
              return false;
            }
            void purge(
              purging,
              typed && typed === purging.homeSchema ? typed : undefined,
            );
          }}
        >
          {session.data?.isAdmin && purging.homeSchema ? (
            <div className="flex flex-col gap-1">
              <Label htmlFor="drop-home-schema">
                {t`Schema name, to remove it there too`}
              </Label>
              <Input
                id="drop-home-schema"
                value={schemaName}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setSchemaName(event.target.value)}
              />
            </div>
          ) : null}
        </ConfirmDialog>
      ) : null}
    </section>
  );
}
