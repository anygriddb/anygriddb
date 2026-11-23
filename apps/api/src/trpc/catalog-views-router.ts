/**
 * Views of a table.
 */
import {
  AppError,
  createViewInputSchema,
  deleteViewInputSchema,
  duplicateViewInputSchema,
  listViewsInputSchema,
  reorderViewsInputSchema,
  updateViewInputSchema,
} from "@anygriddb/core";
import { loadEngine } from "../data/engine.js";
import {
  canEditView,
  createView,
  duplicateView,
  listViews,
  loadView,
  reorderViews,
  trashView,
  updateView,
} from "../data/views.js";
import { hiddenColumnNames, readableTables } from "../data/acl.js";
import { publishViews } from "../realtime/channels.js";
import { logPublish } from "./catalog-shared.js";
import type { Context } from "./context.js";
import { authorize, guardTable, handle, tableAccess } from "./guard.js";
import { procedure, requestNames } from "./init.js";

/**
 * Tells the open screens of a base that the views of a table changed, for
 * a view everyone of the table sees. A person's own view is theirs alone:
 * nobody else is told of it.
 */
async function tellViews(
  ctx: Context,
  table: { id: string; baseId: string },
  shared: boolean,
): Promise<void> {
  if (!shared) return;
  await publishViews(ctx.bus, table.baseId, table.id, logPublish(ctx));
}

export const catalogViewProcedures = {
  views: procedure.input(listViewsInputSchema).query(({ ctx, input }) =>
    handle(ctx, async () => {
      const { user, bindings, table } = await guardTable(
        ctx,
        input.tableId,
        "read",
      );
      const hidden = await hiddenColumnNames(
        ctx.db,
        { userId: user.id, bindings },
        table,
      );
      return { views: await listViews(ctx.db, input.tableId, user.id, hidden) };
    }),
  ),
  createView: procedure
    .input(createViewInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const personal = input.personal === true;
        const { user, bindings, role, table } = await guardTable(
          ctx,
          input.tableId,
          personal ? "read" : "write",
        );
        if (!personal && role !== "owner" && role !== "editor") {
          throw new AppError("access_denied");
        }
        const { engine } = await loadEngine(
          ctx.db,
          input.tableId,
          readableTables(bindings, new Map()),
        );
        const made = await createView(
          ctx.db,
          engine,
          user.id,
          {
            tableId: input.tableId,
            name: input.name,
            viewType: input.viewType,
            config: input.config,
            ownerId: personal ? user.id : null,
          },
          await hiddenColumnNames(ctx.db, { userId: user.id, bindings }, table),
        );
        await tellViews(ctx, table, !personal);
        return made;
      }),
    ),
  updateView: procedure
    .input(updateViewInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const actor = await authorize(ctx);
        const view = await loadView(ctx.db, input.viewId);
        const { user, role, table } = await tableAccess(
          ctx,
          actor,
          view.tableId,
          "read",
        );
        if (
          !canEditView(view, user.id, role) ||
          (input.locked !== undefined && role !== "owner")
        ) {
          throw new AppError("access_denied");
        }
        const { engine } = await loadEngine(ctx.db, view.tableId, () => true);
        const updated = await updateView(
          ctx.db,
          engine,
          user.id,
          view,
          input,
          "web",
          await hiddenColumnNames(
            ctx.db,
            { userId: user.id, bindings: actor.bindings },
            table,
          ),
        );
        await tellViews(ctx, table, view.ownerId === null);
        return updated;
      }),
    ),
  duplicateView: procedure
    .input(duplicateViewInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const actor = await authorize(ctx);
        const view = await loadView(ctx.db, input.viewId);
        const { user, role, table } = await tableAccess(
          ctx,
          actor,
          view.tableId,
          "read",
        );
        const personal = role !== "owner" && role !== "editor";
        if (view.ownerId && view.ownerId !== user.id) {
          throw new AppError("access_denied");
        }
        const shared = !(personal || view.ownerId);
        const copy = await duplicateView(
          ctx.db,
          user.id,
          view,
          input.name ?? (await requestNames(ctx)).copy(view.name).slice(0, 80),
          personal || view.ownerId ? user.id : null,
          await hiddenColumnNames(
            ctx.db,
            { userId: user.id, bindings: actor.bindings },
            table,
          ),
        );
        await tellViews(ctx, table, shared);
        return copy;
      }),
    ),
  reorderViews: procedure
    .input(reorderViewsInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const { user, table } = await guardTable(ctx, input.tableId, "write");
        await reorderViews(ctx.db, user.id, input.tableId, input.order);
        await tellViews(ctx, table, true);
        return { ok: true as const };
      }),
    ),
  deleteView: procedure
    .input(deleteViewInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const actor = await authorize(ctx);
        const view = await loadView(ctx.db, input.viewId);
        const { user, role, table } = await tableAccess(
          ctx,
          actor,
          view.tableId,
          "read",
        );
        if (!canEditView(view, user.id, role)) {
          throw new AppError("access_denied");
        }
        await trashView(ctx.db, user.id, view);
        await tellViews(ctx, table, view.ownerId === null);
        return { ok: true as const };
      }),
    ),
};
