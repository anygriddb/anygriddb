import { z } from "zod";
import { listShortcuts, setPin, touchTable } from "../data/shortcuts.js";
import { guardBase, guardTable, handle } from "./guard.js";
import { procedure, requireUser, t } from "./init.js";

const pinInputSchema = z.union([
  z.object({ baseId: z.uuid(), pinned: z.boolean() }).strict(),
  z.object({ tableId: z.uuid(), pinned: z.boolean() }).strict(),
]);

/**
 * A person's own shortcuts: pinned bases and tables, and the tables they
 * opened last. Pinning and opening need the right to read the target.
 */
export const shortcutsRouter = t.router({
  list: procedure.query(({ ctx }) =>
    handle(ctx, async () => {
      const user = await requireUser(ctx);
      return listShortcuts(ctx.db, user.id);
    }),
  ),
  pin: procedure.input(pinInputSchema).mutation(({ ctx, input }) =>
    handle(ctx, async () => {
      if ("baseId" in input) {
        const { user } = await guardBase(ctx, input.baseId, "read");
        await setPin(ctx.db, user.id, { baseId: input.baseId }, input.pinned);
      } else {
        const { user } = await guardTable(ctx, input.tableId, "read");
        await setPin(ctx.db, user.id, { tableId: input.tableId }, input.pinned);
      }
      return { ok: true as const };
    }),
  ),
  touchTable: procedure
    .input(z.object({ tableId: z.uuid() }).strict())
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const { user } = await guardTable(ctx, input.tableId, "read");
        await touchTable(ctx.db, user.id, input.tableId);
        return { ok: true as const };
      }),
    ),
});
