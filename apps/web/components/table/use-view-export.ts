import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { useErrorText } from "../../lib/errors";
import { downloadJobFile, useTrackJob } from "../../lib/jobs";
import { trpc, useTRPC } from "../../lib/trpc";

/**
 * Downloads a view's rows as a file. Where the instance builds files in
 * jobs, a large view does not hold the page: the job is followed, then its
 * file downloads. Elsewhere the API answers with the file itself.
 */
export function useViewExport(input: {
  tableId: string;
  tableName: string;
  viewId: string | undefined;
  search: string;
}) {
  const { tableId, tableName, viewId, search } = input;
  const { t } = useLingui();
  const errorText = useErrorText();
  const api = useTRPC();
  const jobList = useQuery(api.jobs.list.queryOptions({ limit: 20 }));
  const trackJob = useTrackJob();

  return async function exportView(format: "csv" | "json" | "xlsx") {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (jobList.data?.exportFiles) {
      // Large views take a while: the file is built by a job, then downloaded.
      const asked = {
        tableId,
        viewId,
        format,
        search: search || undefined,
        timeZone,
      };
      let jobId: string;
      try {
        ({ jobId } = await trpc.jobs.startExport.mutate(asked));
      } catch (cause) {
        toast.error(errorText(cause));
        return;
      }
      const job = await trackJob(jobId, {
        label: t`Exporting ${{ table: tableName }}…`,
        onDone: () => ({ message: t`Export ready` }),
      });
      if (job.status === "done" && job.download) downloadJobFile(job.id);
      return;
    }
    const query = new URLSearchParams({ format });
    if (viewId) query.set("viewId", viewId);
    if (search) query.set("search", search);
    query.set("timeZone", timeZone);
    // The API answers with an attachment, so the page stays where it is.
    const link = document.createElement("a");
    link.href = `/api/export/${tableId}?${query.toString()}`;
    link.rel = "noopener";
    link.click();
  };
}
