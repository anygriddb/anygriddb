import { MAX_RESTORE_POINTS, type RestorePoint } from "@anygriddb/core";
import { Button, Input, Label, Spinner } from "@anygriddb/ui";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ArchiveArrowDown, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useErrorText } from "../../lib/errors";
import { formatBytes, formatDate } from "../../lib/format";
import { useLocale } from "../../lib/i18n";
import { useTrackJob } from "../../lib/jobs";
import { useSnapshotGaps } from "../../lib/snapshot-report";
import { trpc, useTRPC } from "../../lib/trpc";
import { ConfirmDialog } from "../shell/dialogs";
import { RuledSection } from "../shell/notebook-page";
import { useInvalidateCatalog } from "../shell/sidebar";

/**
 * A base's restore points (ADR 0077): the whole base kept on the instance
 * for a time, read back as a new base beside it when something went wrong.
 */
export function RestorePoints({
  baseId,
  hasTables,
}: {
  baseId: string;
  hasTables: boolean;
}) {
  const { t } = useLingui();
  const { locale } = useLocale();
  const errorText = useErrorText();
  const snapshotGaps = useSnapshotGaps();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const invalidate = useInvalidateCatalog();
  const navigate = useNavigate();
  const track = useTrackJob();
  const listed = useQuery(api.catalog.restorePoints.queryOptions({ baseId }));
  const [note, setNote] = useState("");
  const [making, setMaking] = useState(false);
  const [removing, setRemoving] = useState<RestorePoint | null>(null);
  const points = listed.data?.points ?? [];
  const full = points.length >= MAX_RESTORE_POINTS;
  const when = (point: RestorePoint) =>
    formatDate(point.createdAt, locale, undefined, true);

  const refresh = () =>
    queryClient.invalidateQueries({
      queryKey: api.catalog.restorePoints.queryKey({ baseId }),
    });

  async function make() {
    setMaking(true);
    try {
      const { jobId } = await trpc.catalog.makeRestorePoint.mutate({
        baseId,
        note: note.trim() || undefined,
      });
      setNote("");
      await track(jobId, {
        label: t`Making a restore point…`,
        onDone: () => ({ message: t`Restore point made` }),
      });
      await refresh();
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setMaking(false);
    }
  }

  async function restore(point: RestorePoint) {
    let jobId: string;
    try {
      ({ jobId } = await trpc.catalog.restoreBase.mutate({
        restorePointId: point.id,
      }));
    } catch (cause) {
      toast.error(errorText(cause));
      return;
    }
    await track(jobId, {
      label: t`Restoring the base as it was on ${{ date: when(point) }}…`,
      onDone: (job) => {
        void invalidate();
        const restored = job.result?.baseId;
        const gaps = snapshotGaps(job.result);
        if (gaps.length > 0) toast.warning(gaps.join(" · "));
        return {
          message: t`Base restored, beside this one`,
          action:
            typeof restored === "string"
              ? {
                  label: t`Open`,
                  onClick: () =>
                    void navigate({
                      to: "/b/$baseId",
                      params: { baseId: restored },
                    }),
                }
              : undefined,
        };
      },
    });
  }

  return (
    <RuledSection
      title={t`Restore points`}
      description={
        listed.data
          ? t`The whole base, its rows, files, views, and members, kept on this instance for ${{ days: listed.data.keepDays }} days. Restoring one makes a new base beside this one: this base is not changed.`
          : undefined
      }
    >
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void make();
        }}
      >
        <div className="flex min-w-60 flex-1 flex-col gap-1">
          <Label htmlFor="restore-point-note">{t`Note (optional)`}</Label>
          <Input
            id="restore-point-note"
            maxLength={200}
            value={note}
            placeholder={t`Before the yearly import`}
            onChange={(event) => setNote(event.target.value)}
          />
        </div>
        <Button
          type="submit"
          size="sm"
          variant="outline"
          disabled={making || full || !hasTables}
        >
          <ArchiveArrowDown className="h-4 w-4" aria-hidden />
          {t`Make a restore point`}
        </Button>
      </form>
      {!hasTables ? (
        <p className="text-sm text-muted-foreground">
          {t`Add at least one table before making a restore point.`}
        </p>
      ) : full ? (
        <p className="text-sm text-muted-foreground">
          {t`A base keeps ${{ count: MAX_RESTORE_POINTS }} restore points at most: delete one to make another.`}
        </p>
      ) : null}
      {listed.isLoading ? <Spinner /> : null}
      {listed.data && points.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t`No restore point yet.`}
        </p>
      ) : null}
      {points.length > 0 ? (
        <ul className="divide-y divide-border">
          {points.map((point) => (
            <li
              key={point.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">
                  {when(point)}
                  {point.note ? ` · ${point.note}` : null}
                </p>
                <p className="text-xs text-muted-foreground">
                  {[
                    point.createdBy?.name,
                    plural(point.rows, { one: "# row", other: "# rows" }),
                    formatBytes(point.size),
                    t`kept until ${{ date: formatDate(point.expiresAt, locale) }}`,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void restore(point)}
              >
                {t`Restore as a new base`}
              </Button>
              <Button
                size="icon"
                variant="ghost"
                aria-label={t`Delete the restore point of ${{ date: when(point) }}`}
                onClick={() => setRemoving(point)}
              >
                <Trash2 className="h-4 w-4" aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title={t`Delete this restore point?`}
        description={
          removing
            ? t`The base as it was on ${{ date: when(removing) }} can no longer be restored. The base itself is not changed.`
            : ""
        }
        confirmLabel={t`Delete`}
        danger
        onConfirm={async () => {
          if (!removing) return;
          try {
            await trpc.catalog.deleteRestorePoint.mutate({
              restorePointId: removing.id,
            });
            await refresh();
          } catch (cause) {
            toast.error(errorText(cause));
          }
        }}
      />
    </RuledSection>
  );
}
