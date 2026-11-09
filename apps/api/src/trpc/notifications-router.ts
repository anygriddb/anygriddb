import { z } from "zod";
import { listNotifications, markRead, unreadCount } from "../notifications.js";
import { handle } from "./guard.js";
import { procedure, requireUser, t } from "./init.js";

export const notificationsRouter = t.router({
  list: procedure
    .input(
      z.object({
        limit: z.int().min(1).max(100).default(30),
        unreadOnly: z.boolean().default(false),
      }),
    )
    .query(({ ctx, input }) =>
      handle(ctx, async () => {
        const user = await requireUser(ctx);
        return {
          notifications: await listNotifications(ctx.db, user.id, input),
          unread: await unreadCount(ctx.db, user.id),
        };
      }),
    ),
  unreadCount: procedure.query(({ ctx }) =>
    handle(ctx, async () => {
      const user = await requireUser(ctx);
      return { unread: await unreadCount(ctx.db, user.id) };
    }),
  ),
  markRead: procedure
    .input(z.object({ ids: z.array(z.uuid()).min(1).max(100).optional() }))
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const user = await requireUser(ctx);
        await markRead(ctx.db, user.id, input.ids);
        return { ok: true as const };
      }),
    ),
  preferences: procedure.query(({ ctx }) =>
    handle(ctx, async () => {
      const user = await requireUser(ctx);
      const row = await ctx.db
        .selectFrom("users")
        .select("notifyByEmail")
        .where("id", "=", user.id)
        .executeTakeFirst();
      return { notifyByEmail: row?.notifyByEmail ?? false };
    }),
  ),
  setPreferences: procedure
    .input(z.object({ notifyByEmail: z.boolean() }))
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const user = await requireUser(ctx);
        await ctx.db
          .updateTable("users")
          .set({ notifyByEmail: input.notifyByEmail })
          .where("id", "=", user.id)
          .execute();
        return { ok: true as const };
      }),
    ),
});
