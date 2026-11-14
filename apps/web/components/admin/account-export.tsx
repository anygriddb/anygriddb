import { Button, Spinner } from "@anygriddb/ui";
import { useLingui } from "@lingui/react/macro";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useErrorText } from "../../lib/errors";
import { useJobs } from "../../lib/jobs";
import { useSession } from "../../lib/session";
import { trpc, useTRPC } from "../../lib/trpc";
import { useAuthLabels } from "./auth-labels";
import { useChangeActionLabel } from "./change-labels";

function date(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString() : "—";
}

/**
 * An account's data on its page (ROADMAP #32): what it wrote lately and
 * what was done to it, as author or as subject, and the export of the
 * whole as a file. The file's first lines say what it holds and what it
 * leaves out.
 */
export function AccountExport({ userId }: { userId: string }) {
  const { t } = useLingui();
  const api = useTRPC();
  const session = useSession();
  const errorText = useErrorText();
  const labels = useAuthLabels();
  const queryClient = useQueryClient();
  const { watch } = useJobs();
  const actionLabel = useChangeActionLabel();
  const [exporting, setExporting] = useState(false);
  const isAdmin = session.data?.isAdmin === true;
  const summary = useQuery({
    ...api.admin.accountData.queryOptions({ userId }),
    enabled: isAdmin,
  });

  if (!isAdmin) return null;

  async function startExport() {
    setExporting(true);
    try {
      const { jobId } = await trpc.admin.exportAccountData.mutate({ userId });
      toast.success(t`Account data export started`);
      void watch(jobId).then((job) => {
        if (job.status === "done") {
          toast.success(t`Account data ready to download from Tasks`);
          void queryClient.invalidateQueries({
            queryKey: api.jobs.list.queryKey(),
          });
        } else if (job.status === "failed") {
          toast.error(t`Account data export failed`);
        }
      });
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setExporting(false);
    }
  }

  if (summary.isError) {
    return (
      <section className="flex flex-col gap-1.5 text-sm">
        <h3 className="text-xs font-medium text-muted-foreground">
          {t`Account data`}
        </h3>
        <p className="text-xs text-danger">
          {t`Could not load the account data.`}
        </p>
      </section>
    );
  }
  if (!summary.data) return <Spinner />;
  const data = summary.data;

  return (
    <section className="flex flex-col gap-3 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-xs font-medium text-muted-foreground">
            {t`Account data`}
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t`${{ writes: data.writes }} writes, ${{ comments: data.comments }} comments, ${{ events: data.accountEvents }} account events. Cell values and comment texts stay out of the file.`}
          </p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          disabled={exporting}
          onClick={() => void startExport()}
        >
          <Download className="mr-1 h-3.5 w-3.5" aria-hidden />
          {t`Export account data`}
        </Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <h4 className="text-xs font-medium text-muted-foreground">
            {t`Recent writes`}
          </h4>
          {data.recentWrites.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t`No write yet.`}</p>
          ) : (
            <ul className="text-xs text-muted-foreground">
              {data.recentWrites.map((row) => (
                <li key={row.id}>
                  {date(row.occurredAt)} · {actionLabel(row.action)}
                  {row.baseName ? ` · ${row.baseName}` : ""}
                  {row.tableName ? ` / ${row.tableName}` : ""}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          <h4 className="text-xs font-medium text-muted-foreground">
            {t`Account events`}
          </h4>
          {data.recentAccount.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {t`No account event yet.`}
            </p>
          ) : (
            <ul className="text-xs text-muted-foreground">
              {data.recentAccount.map((event) => (
                <li key={event.id}>
                  {date(event.occurredAt)} · {labels.action(event.action)}
                  {event.asAuthor && !event.asSubject
                    ? ` · ${t`as actor`}`
                    : ""}
                  {event.method ? ` · ${labels.method(event.method)}` : ""}
                  {event.ip ? ` · ${event.ip}` : ""}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
