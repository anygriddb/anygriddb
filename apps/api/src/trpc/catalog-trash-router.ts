/**
 * The trash of bases, tables, fields, and views.
 */
import {
  AppError,
  effectiveTableRole,
  purgeTrashInputSchema,
  restoreInputSchema,
  roleGrants,
  roleFor,
  trashListInputSchema,
} from "@anygriddb/core";
import { demand, holds } from "../access/declaration.js";
import { enqueueJob } from "../jobs.js";
import {
  baseTrashItems,
  itemBaseId,
  listTrash,
  listTrashedBases,
  loadTrashedTable,
  loadTrashedView,
  restoreBase,
  restoreColumn,
  restoreTable,
  restoreView,
  trashedColumnTable,
} from "../data/trash.js";
import { canEditView } from "../data/views.js";
import { publishCatalog } from "../realtime/channels.js";
import { authorize, guardBase, guardTable, handle } from "./guard.js";
import { asking } from "./init.js";
import { queueDeps } from "./jobs-router.js";
import { logPublish } from "./catalog-shared.js";

export const catalogTrashProcedures = {
  /** What a base's trash holds that the caller may restore. */
  trash: asking({
    asks: ["rows.read"],
    filters: ["schema.manage", "views.manage", "base.manage"],
  })
    .input(trashListInputSchema)
    .query(({ ctx, input }) =>
      handle(ctx, async () => {
        const { user, bindings, role } = await guardBase(
          ctx,
          input.baseId,
          "rows.read",
        );
        const shapeBase = roleGrants(role, "schema.manage");
        const items = await listTrash(ctx.db, input.baseId, user.id);
        const tableRole = (tableId: string | null) =>
          tableId ? effectiveTableRole(bindings, tableId, input.baseId) : null;
        return {
          items: items.filter((item) => {
            if (item.kind === "table") return shapeBase;
            if (item.kind === "column") {
              return roleGrants(tableRole(item.tableId), "schema.manage");
            }
            return roleGrants(tableRole(item.tableId), "views.manage");
          }),
          canPurge: roleGrants(role, "base.manage"),
        };
      }),
    ),
  /** Bases in the trash that the caller managed. */
  trashedBases: asking({ filters: ["base.manage"] }).query(({ ctx }) =>
    handle(ctx, async () => {
      const { bindings } = await authorize(ctx);
      const managed = bindings
        .filter(
          (binding) =>
            binding.scope === "base" && roleGrants(binding.role, "base.manage"),
        )
        .map((binding) => binding.scopeId);
      return { items: await listTrashedBases(ctx.db, managed) };
    }),
  ),
  restore: asking({
    asks: ["rows.read"],
    also: ["base.manage", "schema.manage"],
  })
    .input(restoreInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        switch (input.kind) {
          case "base": {
            const { user, bindings } = await authorize(ctx);
            demand(roleFor(bindings, "base", input.id), "base.manage");
            await restoreBase(ctx.db, user.id, input.id);
            await publishCatalog(ctx.bus, input.id, logPublish(ctx));
            return { baseId: input.id, tableId: null };
          }
          case "table": {
            const table = await loadTrashedTable(ctx.db, input.id);
            const { user } = await guardBase(
              ctx,
              table.baseId,
              "schema.manage",
            );
            await restoreTable(ctx.db, user.id, table.id);
            await publishCatalog(ctx.bus, table.baseId, logPublish(ctx));
            return { baseId: table.baseId, tableId: table.id };
          }
          case "column": {
            const owner = await trashedColumnTable(ctx.db, input.id);
            const { user } = await guardTable(
              ctx,
              owner.tableId,
              "schema.manage",
            );
            await restoreColumn(ctx.db, user.id, input.id);
            await publishCatalog(ctx.bus, owner.baseId, logPublish(ctx));
            return { baseId: owner.baseId, tableId: owner.tableId };
          }
          case "view": {
            const view = await loadTrashedView(ctx.db, input.id);
            const { user, role, table } = await guardTable(
              ctx,
              view.tableId,
              "rows.read",
            );
            if (!canEditView(view, user.id, role)) {
              throw new AppError("access_denied");
            }
            await restoreView(ctx.db, user.id, view);
            return { baseId: table.baseId, tableId: table.id };
          }
        }
      }),
    ),
  /** Deletes items of a base's trash for good, in a background job. */
  purgeTrash: asking({ also: ["bases.oversee"], filters: ["base.manage"] })
    .input(purgeTrashInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const { user, bindings } = await authorize(ctx);
        demand(roleFor(bindings, "base", input.baseId), "base.manage");
        const items =
          input.items ?? (await baseTrashItems(ctx.db, input.baseId, user.id));
        if (items.length === 0) return { jobId: null };
        for (const item of items) {
          if ((await itemBaseId(ctx.db, item)) !== input.baseId) {
            throw new AppError("invalid_restore");
          }
        }
        if (input.dropSchema) {
          if (!holds(user, "bases.oversee"))
            throw new AppError("access_denied");
          const dropsBase = items.some(
            (item) => item.kind === "base" && item.id === input.baseId,
          );
          if (!dropsBase) throw new AppError("invalid_arguments");
          const home = await ctx.db
            .selectFrom("bases")
            .select("homeSchema")
            .where("id", "=", input.baseId)
            .executeTakeFirst();
          if (home?.homeSchema !== input.dropSchema) {
            throw new AppError("invalid_arguments");
          }
        }
        const job = await enqueueJob(queueDeps(ctx), {
          kind: "trash_purge",
          userId: user.id,
          baseId: input.baseId,
          input: {
            baseId: input.baseId,
            items,
            ...(input.dropSchema ? { dropSchema: input.dropSchema } : {}),
          },
        });
        return { jobId: job.id };
      }),
    ),
};
