import {
  type Binding,
  effectiveTableRole,
  PERSON_EVENT_CATALOG,
  personChannelsSchema,
  personEventSchema,
  roleFor,
} from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { z } from "zod";
import { listNotifications, markRead, unreadCount } from "../notifications.js";
import {
  addMute,
  channelsFor,
  listMutes,
  readDefaultChannels,
  removeChannel,
  removeChannelEverywhere,
  removeMute,
  savePreference,
} from "../notify/person-preferences.js";
import { readUnsubscribeToken } from "../notify/unsubscribe.js";
import { authorize, handle, requireEnrolledUser } from "./guard.js";
import { asking, t } from "./init.js";

/**
 * Whether the caller reaches what a mute names: a table of the base by a
 * role on it or on the base, or the base by a role on it or on one of its
 * tables.
 */
async function reachedForMute(
  db: Database,
  bindings: readonly Binding[],
  input: { baseId: string; tableId?: string | undefined },
): Promise<boolean> {
  const tables = await db
    .selectFrom("dataTables")
    .select("id")
    .where("baseId", "=", input.baseId)
    .execute();
  if (input.tableId !== undefined) {
    return tables.some(
      (table) =>
        table.id === input.tableId &&
        effectiveTableRole(bindings, table.id, input.baseId) !== null,
    );
  }
  return (
    roleFor(bindings, "base", input.baseId) !== null ||
    tables.some((table) => roleFor(bindings, "table", table.id) !== null)
  );
}

export const notificationsRouter = t.router({
  list: asking({ exception: "ownAccount" })
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
  markRead: asking({ exception: "ownAccount" })
    .input(z.object({ ids: z.array(z.uuid()).min(1).max(100).optional() }))
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const user = await requireEnrolledUser(ctx);
        await markRead(ctx.db, user.id, input.ids);
        return { ok: true as const };
      }),
    ),
  /** Catalogue, instance defaults, and this person's channels (ADR 0123). */
  preferences: asking({ exception: "ownAccount" }).query(({ ctx }) =>
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
  setPreference: asking({ exception: "ownAccount" })
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
  addMute: asking({ exception: "ownAccount" })
    .input(
      z.object({
        baseId: z.uuid(),
        tableId: z.uuid().optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const { user, bindings } = await authorize(ctx);
        // A base or a table the caller does not reach is answered alike
        // and left unwritten: another answer would say what an id names.
        if (!(await reachedForMute(ctx.db, bindings, input))) {
          return { ok: true as const };
        }
        await addMute(ctx.db, user.id, {
          baseId: input.baseId,
          tableId: input.tableId,
        });
        return { ok: true as const };
      }),
    ),
  removeMute: asking({ exception: "ownAccount" })
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
  unsubscribe: asking({ exception: "unsubscribe" })
    .input(z.object({ token: z.string().min(20).max(500) }))
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const payload = readUnsubscribeToken(
          ctx.env.AUTH_ENCRYPTION_KEY,
          input.token,
        );
        if (!payload) return { ok: false as const, reason: "invalid" as const };
        if (payload.event === null) {
          await removeChannelEverywhere(
            ctx.db,
            payload.userId,
            payload.channel,
          );
          return { ok: true as const, channel: payload.channel };
        }
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
