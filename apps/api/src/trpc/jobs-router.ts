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
  listJobs,
  loadOwnJob,
  publicJob,
  type QueueDeps,
} from "../jobs.js";
import type { Context } from "./context.js";
import { authorize, guardTable, handle } from "./guard.js";
import { procedure, t } from "./init.js";

export function queueDeps(ctx: Context): QueueDeps {
  return {
    db: ctx.db,
    bus: ctx.bus,
    log: (error, message) => ctx.req.log.error({ err: error }, message),
  };
}

export const jobsRouter = t.router({
  /** The caller's recent jobs, newest first. */
  list: procedure.input(listJobsInputSchema).query(({ ctx, input }) =>
    handle(ctx, async () => {
      const { user } = await authorize(ctx);
      return {
        jobs: await listJobs(ctx.db, user.id, input.limit),
        /** Exports run as jobs only when there is somewhere to keep the file. */
        // Exports always run as jobs: there is always a file store.
        exportFiles: true,
      };
    }),
  ),
  get: procedure.input(jobIdInputSchema).query(({ ctx, input }) =>
    handle(ctx, async () => {
      const { user } = await authorize(ctx);
      return publicJob(await loadOwnJob(ctx.db, user.id, input.jobId));
    }),
  ),
  cancel: procedure.input(jobIdInputSchema).mutation(({ ctx, input }) =>
    handle(ctx, async () => {
      const { user } = await authorize(ctx);
      await cancelJob(queueDeps(ctx), user.id, input.jobId);
      return { ok: true as const };
    }),
  ),
  /** Exports a table or view in the background; the file waits 24 hours. */
  startExport: procedure
    .input(exportJobInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const access = await guardTable(ctx, input.tableId, "read");
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
