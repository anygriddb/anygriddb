/**
 * What leaves a base: public links, calendar feeds, and webhooks.
 */
import {
  AppError,
  buildReadRows,
  createWebhookInputSchema,
  deleteWebhookInputSchema,
  embedOriginsInputSchema,
  type FilterGroup,
  listWebhooksInputSchema,
  retryDeliveryInputSchema,
  updateWebhookInputSchema,
  webhookDeliveriesInputSchema,
  webhookIdInputSchema,
} from "@anygriddb/core";
import { z } from "zod";
import {
  createShare,
  listShares,
  revokeShare,
  shareViewId,
} from "../data/sharing.js";
import { resolveSmtp } from "../integrations/smtp.js";
import { loadEngine } from "../data/engine.js";
import { loadView } from "../data/views.js";
import {
  createWebhook,
  deleteWebhook,
  listWebhooks,
  deliveryWebhookId,
  listDeliveries,
  retryDelivery,
  testWebhook,
  updateWebhook,
  webhookTableId,
} from "../webhooks.js";
import type { Context } from "./context.js";
import { guardTable, handle } from "./guard.js";
import { procedure } from "./init.js";
import {
  calendarFeedOf,
  renewCalendarFeed,
  revokeCalendarFeed,
} from "../data/calendar-feeds.js";

/** Watched columns must exist and a filter must compile against the table. */
async function assertWebhookColumns(
  ctx: Context,
  tableId: string,
  input: { filter?: FilterGroup; watchColumns?: string[] },
): Promise<void> {
  if (!input.filter && !input.watchColumns?.length) return;
  const { engine } = await loadEngine(ctx.db, tableId, () => true);
  const names = new Set(engine.table.columns.map((column) => column.name));
  if (input.watchColumns?.some((name) => !names.has(name))) {
    throw new AppError("invalid_webhook");
  }
  if (input.filter) {
    try {
      buildReadRows(engine, { filter: input.filter, limit: 1 });
    } catch (error) {
      throw new AppError("invalid_webhook", { cause: error });
    }
  }
}

export const catalogSharingProcedures = {
  shares: procedure
    .input(z.object({ viewId: z.uuid() }))
    .query(({ ctx, input }) =>
      handle(ctx, async () => {
        const view = await loadView(ctx.db, input.viewId);
        await guardTable(ctx, view.tableId, "write");
        return { shares: await listShares(ctx.db, input.viewId) };
      }),
    ),
  createShare: procedure
    .input(
      z.object({
        viewId: z.uuid(),
        password: z.string().min(8).max(128).optional(),
        expiresInDays: z.int().min(1).max(365).optional(),
        allowCopy: z.boolean().optional(),
        embedOrigins: embedOriginsInputSchema,
      }),
    )
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const view = await loadView(ctx.db, input.viewId);
        const { user } = await guardTable(ctx, view.tableId, "write");
        if (view.ownerId) {
          throw new AppError("invalid_view");
        }
        return createShare(ctx.db, {
          viewId: view.id,
          createdBy: user.id,
          password: input.password,
          expiresAt: input.expiresInDays
            ? new Date(Date.now() + input.expiresInDays * 86_400_000)
            : undefined,
          allowCopy: input.allowCopy === true,
          embedOrigins: input.embedOrigins,
        });
      }),
    ),
  /** The person's private iCal feed of a calendar view, if any. */
  calendarFeed: procedure
    .input(z.object({ viewId: z.uuid() }))
    .query(({ ctx, input }) =>
      handle(ctx, async () => {
        const view = await loadView(ctx.db, input.viewId);
        const { user } = await guardTable(ctx, view.tableId, "read");
        return { feed: await calendarFeedOf(ctx.db, user.id, view.id) };
      }),
    ),
  /** A new feed address, shown once; the previous one stops working. */
  renewCalendarFeed: procedure
    .input(z.object({ viewId: z.uuid() }))
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const view = await loadView(ctx.db, input.viewId);
        const { user } = await guardTable(ctx, view.tableId, "read");
        const token = await renewCalendarFeed(ctx.db, user.id, view.id);
        return { url: `${ctx.env.PUBLIC_URL}/ical/${token}.ics` };
      }),
    ),
  revokeCalendarFeed: procedure
    .input(z.object({ viewId: z.uuid() }))
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const view = await loadView(ctx.db, input.viewId);
        const { user } = await guardTable(ctx, view.tableId, "read");
        await revokeCalendarFeed(ctx.db, user.id, view.id);
        return { ok: true as const };
      }),
    ),
  revokeShare: procedure
    .input(z.object({ shareId: z.uuid() }))
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const view = await loadView(
          ctx.db,
          await shareViewId(ctx.db, input.shareId),
        );
        await guardTable(ctx, view.tableId, "write");
        await revokeShare(ctx.db, input.shareId);
        return { ok: true as const };
      }),
    ),
  webhooks: procedure.input(listWebhooksInputSchema).query(({ ctx, input }) =>
    handle(ctx, async () => {
      await guardTable(ctx, input.tableId, "manage");
      return { webhooks: await listWebhooks(ctx.db, input.tableId) };
    }),
  ),
  createWebhook: procedure
    .input(createWebhookInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const { user } = await guardTable(ctx, input.tableId, "manage");
        await assertWebhookColumns(ctx, input.tableId, input);
        return createWebhook(ctx.db, ctx.env.AUTH_ENCRYPTION_KEY, {
          ...input,
          createdBy: user.id,
        });
      }),
    ),
  updateWebhook: procedure
    .input(updateWebhookInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const tableId = await webhookTableId(ctx.db, input.webhookId);
        await guardTable(ctx, tableId, "manage");
        await assertWebhookColumns(ctx, tableId, {
          filter: input.filter ?? undefined,
          watchColumns: input.watchColumns ?? undefined,
        });
        await updateWebhook(
          ctx.db,
          ctx.env.AUTH_ENCRYPTION_KEY,
          input.webhookId,
          input,
        );
        return { ok: true as const };
      }),
    ),
  testWebhook: procedure
    .input(webhookIdInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        await guardTable(
          ctx,
          await webhookTableId(ctx.db, input.webhookId),
          "manage",
        );
        const { config: smtp } = await resolveSmtp(ctx.db, ctx.env);
        return testWebhook(
          {
            db: ctx.db,
            key: ctx.env.AUTH_ENCRYPTION_KEY,
            smtp,
            log: (error, message) => ctx.req.log.error({ err: error }, message),
          },
          input.webhookId,
        );
      }),
    ),
  webhookDeliveries: procedure
    .input(webhookDeliveriesInputSchema)
    .query(({ ctx, input }) =>
      handle(ctx, async () => {
        await guardTable(
          ctx,
          await webhookTableId(ctx.db, input.webhookId),
          "manage",
        );
        return {
          deliveries: await listDeliveries(
            ctx.db,
            input.webhookId,
            input.limit,
          ),
        };
      }),
    ),
  retryDelivery: procedure
    .input(retryDeliveryInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const webhookId = await deliveryWebhookId(ctx.db, input.deliveryId);
        await guardTable(
          ctx,
          await webhookTableId(ctx.db, webhookId),
          "manage",
        );
        await retryDelivery(ctx.db, input.deliveryId);
        return { ok: true as const };
      }),
    ),
  deleteWebhook: procedure
    .input(deleteWebhookInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        await guardTable(
          ctx,
          await webhookTableId(ctx.db, input.webhookId),
          "manage",
        );
        await deleteWebhook(ctx.db, input.webhookId);
        return { ok: true as const };
      }),
    ),
};
