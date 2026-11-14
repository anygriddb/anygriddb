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
import { guardTable, handle, readableTables } from "./guard.js";
import { procedure, requestNames } from "./init.js";

export const catalogViewProcedures = {
  views: procedure.input(listViewsInputSchema).query(({ ctx, input }) =>
    handle(ctx, async () => {
      const { user } = await guardTable(ctx, input.tableId, "read");
      return { views: await listViews(ctx.db, input.tableId, user.id) };
    }),
  ),
  createView: procedure
    .input(createViewInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const personal = input.personal === true;
        const { user, bindings, role } = await guardTable(
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
        return createView(ctx.db, engine, {
          tableId: input.tableId,
          name: input.name,
          viewType: input.viewType,
          config: input.config,
          ownerId: personal ? user.id : null,
        });
      }),
    ),
  updateView: procedure
    .input(updateViewInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const view = await loadView(ctx.db, input.viewId);
        const { user, role } = await guardTable(ctx, view.tableId, "read");
        if (
          !canEditView(view, user.id, role) ||
          (input.locked !== undefined && role !== "owner")
        ) {
          throw new AppError("access_denied");
        }
        const { engine } = await loadEngine(ctx.db, view.tableId, () => true);
        return updateView(ctx.db, engine, view, input);
      }),
    ),
  duplicateView: procedure
    .input(duplicateViewInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const view = await loadView(ctx.db, input.viewId);
        const { user, role } = await guardTable(ctx, view.tableId, "read");
        const personal = role !== "owner" && role !== "editor";
        if (view.ownerId && view.ownerId !== user.id) {
          throw new AppError("access_denied");
        }
        return duplicateView(
          ctx.db,
          view,
          input.name ?? (await requestNames(ctx)).copy(view.name).slice(0, 80),
          personal || view.ownerId ? user.id : null,
        );
      }),
    ),
  reorderViews: procedure
    .input(reorderViewsInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        await guardTable(ctx, input.tableId, "write");
        await reorderViews(ctx.db, input.tableId, input.order);
        return { ok: true as const };
      }),
    ),
  deleteView: procedure
    .input(deleteViewInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const view = await loadView(ctx.db, input.viewId);
        const { user, role } = await guardTable(ctx, view.tableId, "read");
        if (!canEditView(view, user.id, role)) {
          throw new AppError("access_denied");
        }
        await trashView(ctx.db, user.id, view);
        return { ok: true as const };
      }),
    ),
};
