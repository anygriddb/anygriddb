import {
  PERSON_EVENT_CATALOG,
  personChannelsSchema,
  personEventSchema,
} from "@anygriddb/core";
import { z } from "zod";
import { listNotifications, markRead, unreadCount } from "../notifications.js";
import {
  addMute,
  channelsFor,
  listMutes,
  readDefaultChannels,
  removeChannel,
  removeMute,
  savePreference,
} from "../notify/person-preferences.js";
import { readUnsubscribeToken } from "../notify/unsubscribe.js";
import { handle, requireEnrolledUser } from "./guard.js";
import { procedure, t } from "./init.js";

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
        const user = await requireEnrolledUser(ctx);
        return {
          notifications: await listNotifications(ctx.db, user.id, input),
          unread: await unreadCount(ctx.db, user.id),
        };
      }),
    ),
  markRead: procedure
    .input(z.object({ ids: z.array(z.uuid()).min(1).max(100).optional() }))
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const user = await requireEnrolledUser(ctx);
        await markRead(ctx.db, user.id, input.ids);
        return { ok: true as const };
      }),
    ),
  /** Catalogue, instance defaults, and this person's channels (ADR 0126). */
  preferences: procedure.query(({ ctx }) =>
    handle(ctx, async () => {
      const user = await requireEnrolledUser(ctx);
      const defaults = await readDefaultChannels(ctx.db);
      const events = await Promise.all(
        PERSON_EVENT_CATALOG.map(async (event) => {
          const channels = await channelsFor(
            ctx.db,
            user.id,
            event.id,
            defaults,
          );
          return {
            id: event.id,
            required: [...event.required],
            scoped: event.scoped,
            defaults: defaults.get(event.id) ?? [...event.defaults],
            channels,
          };
        }),
      );
      const mutes = await listMutes(ctx.db, user.id);
      return {
        events,
        mutes: mutes.map((mute) => ({
          id: mute.id,
          baseId: mute.baseId,
          tableId: mute.tableId,
          baseName: mute.baseName,
          tableName: mute.tableName,
          createdAt: mute.createdAt.toISOString(),
        })),
      };
    }),
  ),
  setPreference: procedure
    .input(
      z.object({
        event: personEventSchema,
        channels: personChannelsSchema,
      }),
    )
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const user = await requireEnrolledUser(ctx);
        const channels = await savePreference(
          ctx.db,
          user.id,
          input.event,
          input.channels,
        );
        return { ok: true as const, channels };
      }),
    ),
  addMute: procedure
    .input(
      z.object({
        baseId: z.uuid(),
        tableId: z.uuid().optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const user = await requireEnrolledUser(ctx);
        if (input.tableId) {
          const table = await ctx.db
            .selectFrom("dataTables")
            .select(["id", "baseId"])
            .where("id", "=", input.tableId)
            .executeTakeFirst();
          if (!table || table.baseId !== input.baseId) {
            return { ok: true as const };
          }
        }
        await addMute(ctx.db, user.id, {
          baseId: input.baseId,
          tableId: input.tableId,
        });
        return { ok: true as const };
      }),
    ),
  removeMute: procedure
    .input(z.object({ id: z.uuid() }))
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const user = await requireEnrolledUser(ctx);
        await removeMute(ctx.db, user.id, input.id);
        return { ok: true as const };
      }),
    ),
  /**
   * Applies an unsubscribe link from a mail: no session. Required
   * channels are refused and named.
   */
  unsubscribe: procedure
    .input(z.object({ token: z.string().min(20).max(500) }))
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const payload = readUnsubscribeToken(
          ctx.env.AUTH_ENCRYPTION_KEY,
          input.token,
        );
        if (!payload) return { ok: false as const, reason: "invalid" as const };
        const result = await removeChannel(
          ctx.db,
          payload.userId,
          payload.event,
          payload.channel,
        );
        if (result.refused) {
          return {
            ok: false as const,
            reason: "required" as const,
            event: payload.event,
            channel: payload.channel,
          };
        }
        return {
          ok: true as const,
          event: payload.event,
          channel: payload.channel,
          channels: result.channels,
        };
      }),
    ),
});
