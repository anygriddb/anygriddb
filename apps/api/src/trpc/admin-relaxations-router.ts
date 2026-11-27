/**
 * What the instance relaxed (ADR 0140): listed in one place, relaxed for
 * the instance, and taken back to strict whatever it was relaxed for. A
 * source is relaxed in its own dialog, where its connection is tested.
 */
import {
  AppError,
  RELAXATIONS,
  relaxationKeySchema,
  relaxationSchema,
  type RelaxationTarget,
} from "@anygriddb/core";
import { z } from "zod";
import { withAudit } from "../data/audit-context.js";
import { listRelaxations, setRelaxation } from "../relaxations.js";
import type { Context } from "./context.js";
import { refreshProbe } from "./admin-notify-router.js";
import { handle } from "./guard.js";
import { t } from "./init.js";
import { asking, requireInstance } from "./admin-procedure.js";

/**
 * Relaxes, or goes back to strict, under the change trail's context; then
 * a collector on a private address follows at once. The listing as it is
 * after.
 */
async function change(
  ctx: Context,
  adminId: string,
  target: RelaxationTarget,
  on: boolean,
) {
  const changed = await withAudit(
    ctx.db,
    { userId: adminId, source: "web" },
    (tx) => setRelaxation(tx, { id: adminId, ip: ctx.req.ip }, target, on),
  );
  if (changed) {
    ctx.req.log.info(
      { actor: adminId, key: target.key, source: target.sourceId, on },
      "relaxation changed",
    );
    if (target.key === "notify.private_networks") {
      await refreshProbe(ctx.db, ctx.env, "otlp");
    }
  }
  return listRelaxations(ctx.db);
}

export const relaxationsRouter = t.router({
  list: asking({ asks: ["settings.manage"] }).query(({ ctx }) =>
    handle(ctx, async () => {
      await requireInstance(ctx);
      return listRelaxations(ctx.db);
    }),
  ),
  /** Relaxes a requirement of the instance, its consequence confirmed. */
  relax: asking({ asks: ["settings.manage"] })
    .input(z.object({ key: relaxationKeySchema }).strict())
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireInstance(ctx);
        if (RELAXATIONS[input.key].scope !== "instance") {
          throw new AppError("invalid_input");
        }
        return change(ctx, admin.id, { key: input.key }, true);
      }),
    ),
  /** Goes back to strict: the next connection or call is held to it. */
  end: asking({ asks: ["settings.manage"] })
    .input(relaxationSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireInstance(ctx);
        return change(ctx, admin.id, input, false);
      }),
    ),
});
