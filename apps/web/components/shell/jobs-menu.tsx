import {
  Button,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Spinner,
} from "@anygriddb/ui";
import { useQuery } from "@tanstack/react-query";
import {
  CheckCircle2,
  CircleSlash,
  Copy,
  Download,
  FileDown,
  FileUp,
  ListChecks,
  Trash2,
  XCircle,
} from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import {
  downloadJobFile,
  isFinished,
  useJobErrorText,
  jobPercent,
  useJobs,
  type Job,
} from "../../lib/jobs";
import { useSession } from "../../lib/session";
import { trpc, useTRPC } from "../../lib/trpc";
import { useLingui } from "@lingui/react/macro";
import { useErrorText } from "../../lib/errors";
import { useSnapshotGaps } from "../../lib/snapshot-report";
import { AirtableReport } from "./airtable-report";

const ICONS = {
  import: FileUp,
  export: FileDown,
  duplicate_table: Copy,
  trash_purge: Trash2,
  export_snapshot: Download,
  import_snapshot: FileUp,
  import_airtable: FileUp,
  duplicate_base: Copy,
} as const;

function resultNumber(job: Job, key: string): number {
  const value = job.result?.[key];
  return typeof value === "number" ? value : 0;
}

function resultText(job: Job, key: string): string | undefined {
  const value = job.result?.[key];
  return typeof value === "string" ? value : undefined;
}

/** Gaps from a finished snapshot import or base copy. */
function SnapshotGapsReport({ gaps }: { gaps: string[] }) {
  const { t } = useLingui();
  if (gaps.length === 0) return null;
  return (
    <details className="mt-1 text-xs">
      <summary className="cursor-pointer text-muted-foreground">
        {t`${{ count: gaps.length }} points to check`}
      </summary>
      <ul className="mt-1 max-h-48 list-disc overflow-y-auto pl-4">
        {gaps.map((gap) => (
          <li key={gap}>{gap}</li>
        ))}
      </ul>
    </details>
  );
}

/** The author's recent jobs: progress, cancel, download, and open. */
export function JobsMenu() {
  const { t } = useLingui();
  const jobError = useJobErrorText();
  const errorText = useErrorText();
  const snapshotGaps = useSnapshotGaps();
  const api = useTRPC();
  const navigate = useNavigate();
  const session = useSession();
  const { live } = useJobs();
  const [open, setOpen] = useState(false);
  const list = useQuery({
    ...api.jobs.list.queryOptions({ limit: 20 }),
    enabled: Boolean(session.data),
  });
  const jobs = (list.data?.jobs ?? []).map((job) => {
    const update = live.get(job.id);
    // A finished job's list entry carries its result: keep it over a stale report.
    return update && !isFinished(job.status) ? { ...job, ...update } : job;
  });
  const active = jobs.filter((job) => !isFinished(job.status)).length;
  if (jobs.length === 0) return null;

  function title(job: Job): string {
    const table = job.tableName ?? "—";
    switch (job.kind) {
      case "import":
        return t`Import into ${table}`;
      case "export":
        return t`Export of ${table}`;
      case "duplicate_table":
        return t`Copy of ${table}`;
      case "trash_purge":
        return t`Permanent deletion`;
      case "export_snapshot":
        return t`Base export`;
      case "import_snapshot":
        return t`Base import`;
      case "import_airtable":
        return t`Import from Airtable`;
      case "duplicate_base":
        return t`Base copy`;
    }
  }

  function summary(job: Job): string {
    if (job.status === "queued") return t`Queued`;
    if (job.status === "cancelled") return t`Cancelled`;
    if (job.status === "failed") return jobError(job);
    if (job.status === "running") {
      const percent = jobPercent(job);
      return percent === null ? t`In progress` : t`In progress (${percent}%)`;
    }
    switch (job.kind) {
      case "import":
        return t`${{ inserted: resultNumber(job, "inserted") }} rows added, ${{ updated: resultNumber(job, "updated") }} updated, ${{ failed: resultNumber(job, "failed") }} rejected.`;
      case "export":
        return job.download
          ? t`${{ count: resultNumber(job, "rows") }} rows, file available for 24 h`
          : t`File expired`;
      case "duplicate_table":
        return t`Table created`;
      case "trash_purge":
        return t`${{ count: resultNumber(job, "purged") }} items deleted`;
      case "export_snapshot":
        return job.download ? t`File available for 24 h` : t`File expired`;
      case "import_snapshot":
        return snapshotGaps(job.result).length > 0
          ? t`Base created, with gaps`
          : t`Base created`;
      case "import_airtable":
        return t`Base created: ${{ tables: resultNumber(job, "tables") }} tables, ${{ rows: resultNumber(job, "rows") }} rows.`;
      case "duplicate_base":
        return snapshotGaps(job.result).length > 0
          ? t`Base created, with gaps`
          : t`Base created`;
    }
  }

  async function cancel(job: Job) {
    try {
      await trpc.jobs.cancel.mutate({ jobId: job.id });
    } catch (cause) {
      toast.error(errorText(cause));
    }
  }

  async function retry(job: Job) {
    try {
      await trpc.jobs.retry.mutate({ jobId: job.id });
      await list.refetch();
    } catch (cause) {
      toast.error(errorText(cause));
    }
  }

  function openResult(job: Job) {
    if (
      job.kind === "import_snapshot" ||
      job.kind === "import_airtable" ||
      job.kind === "duplicate_base"
    ) {
      const baseId = resultText(job, "baseId");
      if (!baseId) return;
      setOpen(false);
      void navigate({ to: "/b/$baseId", params: { baseId: baseId } });
      return;
    }
    const tableId =
      job.kind === "duplicate_table"
        ? resultText(job, "tableId")
        : (job.tableId ?? undefined);
    if (!job.baseId || !tableId) return;
    setOpen(false);
    void navigate({
      to: "/b/$baseId/t/$tableId/{-$viewId}",
      params: { baseId: job.baseId, tableId: tableId },
    });
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          className="relative shrink-0"
          aria-label={
            active > 0 ? t`Jobs (${{ count: active }} running)` : t`Tasks`
          }
        >
          {active > 0 ? (
            <Spinner className="h-4 w-4" />
          ) : (
            <ListChecks className="h-4 w-4" aria-hidden />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-0">
        <div className="border-b border-border px-3 py-2 text-sm font-semibold">
          {t`Tasks`}
        </div>
        <ul className="max-h-96 overflow-y-auto">
          {jobs.map((job) => {
            const Icon = ICONS[job.kind];
            const percent = jobPercent(job);
            return (
              <li
                key={job.id}
                className="flex gap-2 border-b border-border px-3 py-2 text-sm last:border-b-0"
              >
                <Icon
                  className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
                  aria-hidden
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{title(job)}</div>
                  <div className="flex items-center gap-1 text-xs text-muted-foreground">
                    {job.status === "done" ? (
                      <CheckCircle2
                        className="h-3 w-3 text-primary"
                        aria-hidden
                      />
                    ) : job.status === "failed" ? (
                      <XCircle className="h-3 w-3 text-danger" aria-hidden />
                    ) : job.status === "cancelled" ? (
                      <CircleSlash className="h-3 w-3" aria-hidden />
                    ) : null}
                    <span className="min-w-0 flex-1">{summary(job)}</span>
                  </div>
                  {job.status === "running" ? (
                    <div
                      className="mt-1 h-1 overflow-hidden rounded bg-muted"
                      role="progressbar"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={percent ?? undefined}
                      aria-label={title(job)}
                    >
                      <div
                        className={
                          percent === null
                            ? "h-full w-1/3 animate-pulse bg-primary"
                            : "h-full bg-primary transition-[width]"
                        }
                        style={
                          percent === null
                            ? undefined
                            : { width: `${percent}%` }
                        }
                      />
                    </div>
                  ) : null}
                  <div className="mt-1 flex gap-2 text-xs">
                    {!isFinished(job.status) ? (
                      <button
                        type="button"
                        className="text-primary hover:underline"
                        onClick={() => void cancel(job)}
                      >
                        {t`Cancel`}
                      </button>
                    ) : null}
                    {job.retryable ? (
                      <button
                        type="button"
                        className="text-primary hover:underline"
                        onClick={() => void retry(job)}
                      >
                        {t`Retry`}
                      </button>
                    ) : null}
                    {(job.kind === "export" ||
                      job.kind === "export_snapshot") &&
                    job.download ? (
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 text-primary hover:underline"
                        onClick={() => downloadJobFile(job.id)}
                      >
                        <Download className="h-3 w-3" aria-hidden />
                        {t`Download`}
                      </button>
                    ) : null}
                    {job.status === "done" &&
                    (job.kind === "import" ||
                      job.kind === "duplicate_table") ? (
                      <button
                        type="button"
                        className="text-primary hover:underline"
                        onClick={() => openResult(job)}
                      >
                        {t`Open the table`}
                      </button>
                    ) : null}
                    {job.status === "done" &&
                    (job.kind === "import_snapshot" ||
                      job.kind === "import_airtable" ||
                      job.kind === "duplicate_base") ? (
                      <button
                        type="button"
                        className="text-primary hover:underline"
                        onClick={() => openResult(job)}
                      >
                        {t`Open base`}
                      </button>
                    ) : null}
                    <span className="ml-auto text-muted-foreground">
                      {new Date(job.createdAt).toLocaleTimeString()}
                    </span>
                  </div>
                  {job.status === "done" && job.kind === "import_airtable" ? (
                    <AirtableReport report={job.result?.report} />
                  ) : null}
                  {job.status === "done" &&
                  (job.kind === "import_snapshot" ||
                    job.kind === "duplicate_base") ? (
                    <SnapshotGapsReport gaps={snapshotGaps(job.result)} />
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
