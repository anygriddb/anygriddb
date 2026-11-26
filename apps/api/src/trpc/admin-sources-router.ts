/**
 * Client databases, as an administrator declares them.
 */
import {
  AppError,
  roleFor,
  sourceInputSchema,
  sourceUpdateSchema,
} from "@anygriddb/core";
import { demand, holds } from "../access/declaration.js";
import { z } from "zod";
import {
  exposeTables,
  refreshExposedTable,
  setTableWrites,
} from "../sources/expose.js";
import { setTableWatch, watchColumns } from "../sources/watch.js";
import { setTableSync, syncNow } from "../sources/sync.js";
import { sourceImpact, sourceReachable } from "../sources/impact.js";
import {
  createSource,
  deleteSource,
  exposedIn,
  listSourceTables,
  listSources,
  recheckSource,
  testSource,
  updateSource,
  type SourceDeps,
} from "../sources/sources.js";
import { publishCatalog } from "../realtime/channels.js";
import { loadBindings } from "../auth/access.js";
import type { Context } from "./context.js";
import { handle } from "./guard.js";
import { requestNames, t } from "./init.js";
import { asking, requireInstance } from "./admin-procedure.js";

function sourceDeps(ctx: Context): SourceDeps {
  return {
    db: ctx.db,
    key: ctx.env.AUTH_ENCRYPTION_KEY,
    settings: ctx.sources,
  };
}

/** What a source's account may read, as the administration page shows it. */
async function presentedTables(ctx: Context, id: string, search?: string) {
  // First, and alone: read beside the others, a source that is not there
  // failed two of them, and the first to fail chose the answer.
  const source = await ctx.db
    .selectFrom("sources")
    .select("engine")
    .where("id", "=", id)
    .executeTakeFirst();
  if (!source) throw new AppError("unknown_source");
  const [listing, exposed] = await Promise.all([
    listSourceTables(sourceDeps(ctx), id, {
      ...(search ? { scope: { search } } : {}),
    }),
    exposedIn(ctx.db, id),
  ]);
  return {
    truncated: listing.truncated,
    tables: listing.tables.map((table) => ({
      ...table,
      changeTracking: table.changeTracking ?? false,
      // Columns that can tell changes made elsewhere (ADR 0031).
      watchColumns: watchColumns(source.engine, table),
      exposedIn: exposed.get(`${table.schema}.${table.name}`) ?? [],
    })),
  };
}

/** Client databases (ADR 0026): declared and checked by administrators. */
export const sourcesRouter = t.router({
  settings: asking({ asks: ["sources.manage"] }).query(({ ctx }) =>
    handle(ctx, async () => {
      await requireInstance(ctx);
      return {
        allowedHosts: [...ctx.sources.allowedHosts],
        allowPlaintext: ctx.sources.allowPlaintext,
        impact: await sourceImpact(ctx.db, ctx.sources),
      };
    }),
  ),
  list: asking({ asks: ["sources.manage"] }).query(({ ctx }) =>
    handle(ctx, async () => {
      await requireInstance(ctx);
      const rows = await listSources(ctx.db);
      return rows.map((row) => ({
        ...row,
        hostAllowed: sourceReachable(ctx.sources.allows, row),
        // The primary is on the list, and its replica is what refuses it.
        replicaBlocked:
          ctx.sources.allows(row.host) &&
          !sourceReachable(ctx.sources.allows, row),
      }));
    }),
  ),
  test: asking({ asks: ["sources.manage"] })
    .input(sourceInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        await requireInstance(ctx);
        return testSource(sourceDeps(ctx), input);
      }),
    ),
  create: asking({ asks: ["sources.manage"] })
    .input(sourceInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireInstance(ctx);
        const created = await createSource(sourceDeps(ctx), admin.id, input);
        ctx.req.log.info(
          { actor: admin.id, source: created.id },
          "source declared",
        );
        return created;
      }),
    ),
  update: asking({ asks: ["sources.manage"] })
    .input(sourceUpdateSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireInstance(ctx);
        return updateSource(sourceDeps(ctx), admin.id, input);
      }),
    ),
  check: asking({ asks: ["sources.manage"] })
    .input(z.object({ id: z.uuid() }))
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        await requireInstance(ctx);
        return recheckSource(sourceDeps(ctx), input.id);
      }),
    ),
  expose: asking({
    asks: ["sources.manage"],
    also: ["bases.oversee", "schema.manage"],
  })
    .input(
      z.object({
        sourceId: z.uuid(),
        baseId: z.uuid(),
        tables: z
          .array(
            z.object({
              schema: z.string().min(1).max(128),
              name: z.string().min(1).max(128),
            }),
          )
          .min(1)
          .max(100),
      }),
    )
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireInstance(ctx);
        // A source manager brings tables into the bases it owns; an
        // administrator into any (ADR 0126).
        if (!holds(admin, "bases.oversee")) {
          const role = roleFor(
            await loadBindings(ctx.db, admin.id),
            "base",
            input.baseId,
          );
          demand(role, "schema.manage");
        }
        const result = await exposeTables(
          sourceDeps(ctx),
          admin.id,
          input,
          (await requestNames(ctx)).grid,
        );
        await publishCatalog(ctx.bus, input.baseId, (error) => {
          ctx.req.log.error({ err: error }, "catalog publish failed");
        });
        return result;
      }),
    ),
  setWrites: asking({ asks: ["sources.manage"] })
    .input(
      z.object({
        tableId: z.uuid(),
        update: z.boolean(),
        insert: z.boolean(),
        delete: z.boolean(),
      }),
    )
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireInstance(ctx);
        const result = await setTableWrites(sourceDeps(ctx), admin.id, input);
        await publishCatalog(ctx.bus, result.baseId, (error) => {
          ctx.req.log.error({ err: error }, "catalog publish failed");
        });
        return result;
      }),
    ),
  refreshTable: asking({ asks: ["sources.manage"] })
    .input(z.object({ tableId: z.uuid() }))
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireInstance(ctx);
        const result = await refreshExposedTable(
          sourceDeps(ctx),
          admin.id,
          input.tableId,
        );
        await publishCatalog(ctx.bus, result.baseId, (error) => {
          ctx.req.log.error({ err: error }, "catalog publish failed");
        });
        return result;
      }),
    ),
  setWatch: asking({ asks: ["sources.manage"] })
    .input(
      z.object({
        tableId: z.uuid(),
        method: z.enum(["column", "change_tracking"]).nullable(),
        column: z.string().min(1).max(128).optional(),
        intervalSeconds: z.int().min(5).max(86_400),
      }),
    )
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireInstance(ctx);
        await setTableWatch(sourceDeps(ctx), admin.id, input);
        return { ok: true as const };
      }),
    ),
  setSync: asking({ asks: ["sources.manage"] })
    .input(
      z.object({
        tableId: z.uuid(),
        // Null reads the table live again.
        intervalMinutes: z.int().min(1).max(10_080).nullable(),
        syncMode: z.enum(["full", "incremental"]).optional(),
        changeColumn: z.string().min(1).max(128).nullable().optional(),
        fullEvery: z.int().min(1).max(10_080).optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireInstance(ctx);
        const { baseId } = await setTableSync(ctx.db, admin.id, input);
        await publishCatalog(ctx.bus, baseId, (error) => {
          ctx.req.log.error({ err: error }, "catalog publish failed");
        });
        return { ok: true as const };
      }),
    ),
  /**
   * Where each exposed table stands (writes, watch, copy), from AnyGridDB's
   * database only: cheap to read again while a refresh runs.
   */
  exposures: asking({ asks: ["sources.manage"] })
    .input(z.object({ id: z.uuid() }))
    .query(({ ctx, input }) =>
      handle(ctx, async () => {
        await requireInstance(ctx);
        return Object.fromEntries(await exposedIn(ctx.db, input.id));
      }),
    ),
  syncNow: asking({ asks: ["sources.manage"] })
    .input(z.object({ tableId: z.uuid() }))
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        await requireInstance(ctx);
        await syncNow(ctx.db, input.tableId);
        return { ok: true as const };
      }),
    ),
  tables: asking({ asks: ["sources.browse"] })
    .input(z.object({ id: z.uuid() }))
    .query(({ ctx, input }) =>
      handle(ctx, async () => {
        await requireInstance(ctx);
        return (await presentedTables(ctx, input.id)).tables;
      }),
    ),
  /** The same list, whether it was cut, and a search to reach the rest. */
  tableListing: asking({ asks: ["sources.manage"] })
    .input(
      z.object({
        id: z.uuid(),
        search: z.string().trim().min(1).max(128).optional(),
      }),
    )
    .query(({ ctx, input }) =>
      handle(ctx, async () => {
        await requireInstance(ctx);
        return presentedTables(ctx, input.id, input.search);
      }),
    ),
  delete: asking({ asks: ["sources.manage"] })
    .input(z.object({ id: z.uuid() }))
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireInstance(ctx);
        await deleteSource(sourceDeps(ctx), admin.id, input.id);
        return { ok: true as const };
      }),
    ),
});
