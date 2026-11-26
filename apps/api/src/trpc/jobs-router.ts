import {
  AppError,
  exportJobInputSchema,
  jobIdInputSchema,
  listJobsInputSchema,
} from "@anygriddb/core";
import { loadView } from "../data/views.js";
import {
  cancelJob,
  enqueueJob,
  jobMakesBase,
  listJobs,
  loadOwnJob,
  presentJob,
  publicJob,
  retryJob,
  type QueueDeps,
} from "../jobs.js";
import type { Context } from "./context.js";
import { authorize, guardTable, handle } from "./guard.js";
import { asking, t } from "./init.js";

export function queueDeps(ctx: Context): QueueDeps {
  return {
    db: ctx.db,
    bus: ctx.bus,
    log: (error, message) => ctx.req.log.error({ err: error }, message),
  };
}

export const jobsRouter = t.router({
  /** The caller's recent jobs, newest first. */
  list: asking({ exception: "ownAccount" })
    .input(listJobsInputSchema)
    .query(({ ctx, input }) =>
      handle(ctx, async () => {
        const actor = await authorize(ctx);
        return {
          jobs: await listJobs(ctx.db, actor, input.limit, ctx.tokenScope),
          /**
           * Whether an export can run as a job, its file kept until fetched:
           * always, since there is always a file store. A view of up to
           * 100,000 rows is also sent at once (`GET /api/export/:tableId`).
           */
          exportFiles: true,
        };
      }),
    ),
  get: asking({ exception: "ownAccount" })
    .input(jobIdInputSchema)
    .query(({ ctx, input }) =>
      handle(ctx, async () => {
        const actor = await authorize(ctx);
        return presentJob(
          ctx.db,
          await loadOwnJob(ctx.db, actor.user.id, input.jobId, ctx.tokenScope),
          actor,
        );
      }),
    ),
  cancel: asking({ exception: "ownAccount" })
    .input(jobIdInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const { user } = await authorize(ctx);
        await loadOwnJob(ctx.db, user.id, input.jobId, ctx.tokenScope);
        await cancelJob(queueDeps(ctx), user.id, input.jobId);
        return { ok: true as const };
      }),
    ),
  /** Puts a failed or interrupted job back on the queue. */
  retry: asking({ exception: "ownAccount" })
    .input(jobIdInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const { user } = await authorize(ctx);
        const job = await loadOwnJob(
          ctx.db,
          user.id,
          input.jobId,
          ctx.tokenScope,
        );
        // Started again, it makes a base: it asks what making one asks.
        if (jobMakesBase(job)) await authorize(ctx, true);
        // A retry has no file yet; the flag stays off until the run finishes.
        return publicJob(await retryJob(queueDeps(ctx), user.id, input.jobId));
      }),
    ),
  /** Exports a table or view in the background; the file waits 24 hours. */
  startExport: asking({ asks: ["data.export"] })
    .input(exportJobInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const access = await guardTable(ctx, input.tableId, "data.export");
        if (input.viewId) {
          const view = await loadView(ctx.db, input.viewId);
          if (
            view.tableId !== access.table.id ||
            (view.ownerId && view.ownerId !== access.user.id)
          ) {
            throw new AppError("invalid_view");
          }
        }
        const job = await enqueueJob(queueDeps(ctx), {
          kind: "export",
          userId: access.user.id,
          baseId: access.table.baseId,
          tableId: access.table.id,
          input,
        });
        return { jobId: job.id };
      }),
    ),
});
