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
  LINK_PERMISSIONS,
  listWebhooksInputSchema,
  retryDeliveryInputSchema,
  updateWebhookInputSchema,
  webhookDeliveriesInputSchema,
  webhookIdInputSchema,
} from "@anygriddb/core";
import { z } from "zod";
import {
  createBaseShare,
  createShare,
  listBaseShares,
  listShares,
  revokeShare,
  shareTarget,
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
  testWebhook,
  updateWebhook,
  webhookTableId,
} from "../webhooks.js";
import { retryDelivery } from "../outbound/deliveries.js";
import type { Context } from "./context.js";
import {
  assertGrants,
  assertGrantsAll,
  authorize,
  baseAccess,
  guardBase,
  guardTable,
  handle,
  tableAccess,
} from "./guard.js";
import { asking } from "./init.js";
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
  shares: asking({ asks: ["publish"] })
    .input(z.object({ viewId: z.uuid() }))
    .query(({ ctx, input }) =>
      handle(ctx, async () => {
        const actor = await authorize(ctx);
        const view = await loadView(ctx.db, input.viewId);
        await tableAccess(ctx, actor, view.tableId, "publish");
        return { shares: await listShares(ctx.db, input.viewId) };
      }),
    ),
  createShare: asking({ asks: ["publish"], also: ["data.export"] })
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
        const actor = await authorize(ctx);
        const view = await loadView(ctx.db, input.viewId);
        const { user, role } = await tableAccess(
          ctx,
          actor,
          view.tableId,
          "publish",
        );
        // A view's link shows its rows to whoever holds it: an export.
        assertGrantsAll(
          role,
          LINK_PERMISSIONS[view.viewType === "form" ? "form" : "view"],
        );
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
  calendarFeed: asking({ asks: ["data.export"] })
    .input(z.object({ viewId: z.uuid() }))
    .query(({ ctx, input }) =>
      handle(ctx, async () => {
        const actor = await authorize(ctx);
        const view = await loadView(ctx.db, input.viewId);
        const { user } = await tableAccess(
          ctx,
          actor,
          view.tableId,
          "data.export",
        );
        return { feed: await calendarFeedOf(ctx.db, user.id, view.id) };
      }),
    ),
  /** A new feed address, shown once; the previous one stops working. */
  renewCalendarFeed: asking({ asks: ["data.export"] })
    .input(z.object({ viewId: z.uuid() }))
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const actor = await authorize(ctx);
        const view = await loadView(ctx.db, input.viewId);
        const { user } = await tableAccess(
          ctx,
          actor,
          view.tableId,
          "data.export",
        );
        const token = await renewCalendarFeed(ctx.db, user.id, view.id);
        return { url: `${ctx.env.PUBLIC_URL}/ical/${token}.ics` };
      }),
    ),
  revokeCalendarFeed: asking({ asks: ["data.export"] })
    .input(z.object({ viewId: z.uuid() }))
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const actor = await authorize(ctx);
        const view = await loadView(ctx.db, input.viewId);
        const { user } = await tableAccess(
          ctx,
          actor,
          view.tableId,
          "data.export",
        );
        await revokeCalendarFeed(ctx.db, user.id, view.id);
        return { ok: true as const };
      }),
    ),
  /**
   * Revokes a link: a view's by those who may write in its table, a whole
   * base's by those who manage the base.
   */
  revokeShare: asking({ asks: ["publish"], also: ["base.manage"] })
    .input(z.object({ shareId: z.uuid() }))
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const actor = await authorize(ctx);
        const target = await shareTarget(ctx.db, input.shareId);
        if ("baseId" in target) {
          await baseAccess(ctx, actor, target.baseId, "base.manage");
        } else {
          const view = await loadView(ctx.db, target.viewId);
          await tableAccess(ctx, actor, view.tableId, "publish");
        }
        await revokeShare(ctx.db, actor.user.id, input.shareId);
        return { ok: true as const };
      }),
    ),
  /** A base's read-only links (ROADMAP row 93), for its managers. */
  baseShares: asking({ asks: ["base.manage"] })
    .input(z.object({ baseId: z.uuid() }))
    .query(({ ctx, input }) =>
      handle(ctx, async () => {
        await guardBase(ctx, input.baseId, "base.manage");
        return { shares: await listBaseShares(ctx.db, input.baseId) };
      }),
    ),
  /**
   * A link that shows the whole base, read-only, as its creator reads it.
   * Its token is shown once.
   */
  createBaseShare: asking({ asks: ["base.manage", "publish", "data.export"] })
    .input(
      z.object({
        baseId: z.uuid(),
        password: z.string().min(8).max(128).optional(),
        expiresInDays: z.int().min(1).max(365).optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const { user, role } = await guardBase(
          ctx,
          input.baseId,
          "base.manage",
        );
        assertGrantsAll(role, LINK_PERMISSIONS.base);
        return createBaseShare(ctx.db, {
          baseId: input.baseId,
          createdBy: user.id,
          password: input.password,
          expiresAt: input.expiresInDays
            ? new Date(Date.now() + input.expiresInDays * 86_400_000)
            : undefined,
        });
      }),
    ),
  webhooks: asking({ asks: ["webhooks.manage"] })
    .input(listWebhooksInputSchema)
    .query(({ ctx, input }) =>
      handle(ctx, async () => {
        await guardTable(ctx, input.tableId, "webhooks.manage");
        return { webhooks: await listWebhooks(ctx.db, input.tableId) };
      }),
    ),
  createWebhook: asking({ asks: ["data.export", "webhooks.manage"] })
    .input(createWebhookInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const { user, role } = await guardTable(
          ctx,
          input.tableId,
          "webhooks.manage",
        );
        // A webhook sends the table's rows out of the instance: an export.
        assertGrants(role, "data.export");
        await assertWebhookColumns(ctx, input.tableId, input);
        return createWebhook(ctx.db, ctx.env.AUTH_ENCRYPTION_KEY, {
          ...input,
          createdBy: user.id,
        });
      }),
    ),
  updateWebhook: asking({ asks: ["data.export", "webhooks.manage"] })
    .input(updateWebhookInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const actor = await authorize(ctx);
        const tableId = await webhookTableId(ctx.db, input.webhookId);
        const { user, role } = await tableAccess(
          ctx,
          actor,
          tableId,
          "webhooks.manage",
        );
        assertGrants(role, "data.export");
        await assertWebhookColumns(ctx, tableId, {
          filter: input.filter ?? undefined,
          watchColumns: input.watchColumns ?? undefined,
        });
        await updateWebhook(
          ctx.db,
          ctx.env.AUTH_ENCRYPTION_KEY,
          user.id,
          input.webhookId,
          input,
        );
        return { ok: true as const };
      }),
    ),
  testWebhook: asking({ asks: ["data.export", "webhooks.manage"] })
    .input(webhookIdInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const { role } = await tableAccess(
          ctx,
          await authorize(ctx),
          await webhookTableId(ctx.db, input.webhookId),
          "webhooks.manage",
        );
        assertGrants(role, "data.export");
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
  webhookDeliveries: asking({ asks: ["webhooks.manage"] })
    .input(webhookDeliveriesInputSchema)
    .query(({ ctx, input }) =>
      handle(ctx, async () => {
        await tableAccess(
          ctx,
          await authorize(ctx),
          await webhookTableId(ctx.db, input.webhookId),
          "webhooks.manage",
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
  retryDelivery: asking({ asks: ["webhooks.manage"] })
    .input(retryDeliveryInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const actor = await authorize(ctx);
        const webhookId = await deliveryWebhookId(ctx.db, input.deliveryId);
        await tableAccess(
          ctx,
          actor,
          await webhookTableId(ctx.db, webhookId),
          "webhooks.manage",
        );
        await retryDelivery(ctx.db, input.deliveryId, { webhookId });
        return { ok: true as const };
      }),
    ),
  deleteWebhook: asking({ asks: ["webhooks.manage"] })
    .input(deleteWebhookInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const { user } = await tableAccess(
          ctx,
          await authorize(ctx),
          await webhookTableId(ctx.db, input.webhookId),
          "webhooks.manage",
        );
        await deleteWebhook(ctx.db, user.id, input.webhookId);
        return { ok: true as const };
      }),
    ),
};
