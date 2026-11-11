import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { toast } from "sonner";
import { useChannel } from "./realtime";
import { useSession } from "./session";
import { trpc, useTRPC, type RouterOutputs } from "./trpc";
import { useLingui } from "@lingui/react/macro";
import { useErrorText } from "./errors";

export type Job = RouterOutputs["jobs"]["get"];
export type JobStatus = Job["status"];
export type JobUpdate = {
  status: JobStatus;
  done: number;
  total: number | null;
};

const FINISHED = new Set<JobStatus>(["done", "failed", "cancelled"]);
/** Watched jobs are also polled, in case the socket missed the last report. */
const POLL_MS = 5_000;

export function isFinished(status: JobStatus): boolean {
  return FINISHED.has(status);
}

/** Whole percent done, or null while the total is unknown. */
export function jobPercent(update: {
  done: number;
  total: number | null;
}): number | null {
  if (update.total === null || update.total <= 0) return null;
  return Math.min(100, Math.floor((update.done / update.total) * 100));
}

export function jobFileUrl(jobId: string): string {
  return `/api/jobs/${jobId}/file`;
}

/** Starts the download of an export: the API answers with an attachment. */
export function downloadJobFile(jobId: string): void {
  const link = document.createElement("a");
  link.href = jobFileUrl(jobId);
  link.rel = "noopener";
  link.click();
}

type Watcher = {
  onUpdate?: (update: JobUpdate) => void;
  resolve: (job: Job) => void;
};

type JobsApi = {
  /** Latest progress of each job reported since the page loaded. */
  live: ReadonlyMap<string, JobUpdate>;
  /** Resolves once the job finished; `onUpdate` sees each report before. */
  watch: (
    jobId: string,
    onUpdate?: (update: JobUpdate) => void,
  ) => Promise<Job>;
};

const JobsContext = createContext<JobsApi | null>(null);

export function JobsProvider({ children }: { children: ReactNode }) {
  const session = useSession();
  const api = useTRPC();
  const queryClient = useQueryClient();
  const watchers = useRef(new Map<string, Set<Watcher>>());
  const statuses = useRef(new Map<string, JobStatus>());
  const [live, setLive] = useState<ReadonlyMap<string, JobUpdate>>(new Map());

  const report = useCallback(
    (jobId: string, update: JobUpdate) => {
      setLive((current) => new Map(current).set(jobId, update));
      for (const watcher of watchers.current.get(jobId) ?? []) {
        watcher.onUpdate?.(update);
      }
      // The list is re-read when a job changes state, not on every report.
      if (statuses.current.get(jobId) !== update.status) {
        statuses.current.set(jobId, update.status);
        void queryClient.invalidateQueries({
          queryKey: api.jobs.list.queryKey(),
        });
      }
    },
    [api, queryClient],
  );

  const settle = useCallback(
    async (jobId: string) => {
      const set = watchers.current.get(jobId);
      if (!set || set.size === 0) return;
      let job: Job;
      try {
        job = await trpc.jobs.get.query({ jobId });
      } catch {
        // A failed read is retried by the next poll.
        return;
      }
      report(jobId, { status: job.status, done: job.done, total: job.total });
      if (!isFinished(job.status)) return;
      watchers.current.delete(jobId);
      for (const watcher of set) watcher.resolve(job);
    },
    [report],
  );

  useChannel(session.data?.id, {
    message: (message) => {
      if (message.type !== "job") return;
      report(message.jobId, {
        status: message.status,
        done: message.done,
        total: message.total,
      });
      if (isFinished(message.status)) void settle(message.jobId);
    },
    resync: () => {
      for (const jobId of watchers.current.keys()) void settle(jobId);
      void queryClient.invalidateQueries({
        queryKey: api.jobs.list.queryKey(),
      });
    },
  });

  useEffect(() => {
    const timer = setInterval(() => {
      for (const jobId of watchers.current.keys()) void settle(jobId);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [settle]);

  const watch = useCallback(
    (jobId: string, onUpdate?: (update: JobUpdate) => void) =>
      new Promise<Job>((resolve) => {
        const set = watchers.current.get(jobId) ?? new Set<Watcher>();
        set.add({ onUpdate, resolve });
        watchers.current.set(jobId, set);
        // The job may have finished before anyone watched it.
        void settle(jobId);
      }),
    [settle],
  );

  const value = useMemo(() => ({ live, watch }), [live, watch]);
  return <JobsContext.Provider value={value}>{children}</JobsContext.Provider>;
}

export function useJobs(): JobsApi {
  const value = useContext(JobsContext);
  if (!value) throw new Error("JobsProvider missing");
  return value;
}

/** Why a job failed, in the person's language: its code, or its text. */
export function useJobErrorText(): (job: {
  error: string | null;
  reason: unknown;
}) => string {
  const { t } = useLingui();
  const errorText = useErrorText();
  return useCallback(
    (job) =>
      job.reason
        ? errorText(job)
        : job.error
          ? errorText(job.error)
          : t`The job failed`,
    [t, errorText],
  );
}

type Done = {
  message: string;
  action?: { label: string; onClick: () => void };
};

/**
 * Follows a job in a toast with its progress and a cancel button, and
 * resolves with the finished job.
 */
export function useTrackJob() {
  const { t } = useLingui();
  const jobError = useJobErrorText();
  const { watch } = useJobs();
  return useCallback(
    async (
      jobId: string,
      options: { label: string; onDone?: (job: Job) => Done | undefined },
    ): Promise<Job> => {
      const cancel = {
        label: t`Cancel`,
        onClick: () => {
          trpc.jobs.cancel.mutate({ jobId }).catch(() => {
            toast.error(t`The job has already finished`);
          });
        },
      };
      toast.loading(options.label, { id: jobId, action: cancel });
      const job = await watch(jobId, (update) => {
        if (isFinished(update.status)) return;
        const percent = jobPercent(update);
        toast.loading(
          percent === null
            ? options.label
            : t`${{ label: options.label }} (${percent}%)`,
          { id: jobId, action: cancel },
        );
      });
      if (job.status === "done") {
        const done = options.onDone?.(job);
        toast.success(done?.message ?? t`Job finished`, {
          id: jobId,
          action: done?.action,
        });
      } else if (job.status === "cancelled") {
        toast.message(t`Job cancelled`, { id: jobId, action: undefined });
      } else {
        toast.error(jobError(job), {
          id: jobId,
          action: undefined,
        });
      }
      return job;
    },
    [t, watch, jobError],
  );
}
