import {
  AppError,
  earlierInputSchema,
  revertCatalogInputSchema,
} from "@anygriddb/core";
import { canEditView } from "../data/views.js";
import { listEarlier, locateRevert, revertCatalog } from "../data/revert.js";
import { publishCatalog } from "../realtime/channels.js";
import { authorize, baseAccess, handle, tableAccess } from "./guard.js";
import type { Context } from "./context.js";
import { asking } from "./init.js";

function logPublish(ctx: Context) {
  return (error: unknown) =>
    ctx.req.log.error({ err: error }, "catalog publish failed");
}

async function guarded(
  ctx: Context,
  kind: (typeof earlierInputSchema)["_output"]["kind"],
  id: string,
) {
  const actor = await authorize(ctx);
  const loaded = await locateRevert(ctx.db, kind, id);
  if (kind === "view") {
    if (!loaded.tableId || !loaded.view) throw new AppError("no_row");
    const { user, role } = await tableAccess(
      ctx,
      actor,
      loaded.tableId,
      "rows.read",
    );
    if (loaded.personal || !canEditView(loaded.view, user.id, role)) {
      throw new AppError("access_denied");
    }
    return { userId: user.id, loaded };
  }
  if (loaded.tableId) {
    const { user } = await tableAccess(
      ctx,
      actor,
      loaded.tableId,
      "schema.manage",
    );
    return { userId: user.id, loaded };
  }
  const { user } = await baseAccess(ctx, actor, loaded.baseId, "schema.manage");
  return { userId: user.id, loaded };
}

export const catalogRevertProcedures = {
  earlier: asking({
    asks: ["rows.read"],
    also: ["schema.manage", "views.manage"],
  })
    .input(earlierInputSchema)
    .query(({ ctx, input }) =>
      handle(ctx, async () => {
        const { loaded } = await guarded(ctx, input.kind, input.id);
        return {
          events: await listEarlier(ctx.db, input.kind, input.id, loaded),
        };
      }),
    ),
  revert: asking({
    asks: ["rows.read"],
    also: ["schema.manage", "views.manage"],
  })
    .input(revertCatalogInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const { userId, loaded } = await guarded(ctx, input.kind, input.id);
        await revertCatalog(
          ctx.db,
          userId,
          input,
          loaded,
          ctx.env.AUTH_ENCRYPTION_KEY,
        );
        await publishCatalog(ctx.bus, loaded.baseId, logPublish(ctx));
        return { ok: true as const };
      }),
    ),
};
