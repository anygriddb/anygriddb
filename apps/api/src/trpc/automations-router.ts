import {
  AppError,
  createAutomationInputSchema,
  updateAutomationInputSchema,
} from "@anygriddb/core";
import { z } from "zod";
import {
  assertAutomation,
  automationTableId,
  deleteAutomation,
  listAutomations,
  listRuns,
  pressButton,
  runAutomation,
  renewAutomationWebhook,
  saveAutomation,
  writtenTables,
  setAutomationEnabled,
  type AutomationDeps,
} from "../automations.js";
import type { Context } from "./context.js";
import { guardTable, handle } from "./guard.js";
import { procedure, t } from "./init.js";
import { liveColumn, liveView } from "../data/live.js";
import { resolveSmtp } from "../integrations/smtp.js";

async function automationDeps(ctx: Context): Promise<AutomationDeps> {
  const { config: smtp } = await resolveSmtp(ctx.db, ctx.env);
  return {
    db: ctx.db,
    bus: ctx.bus,
    smtp,
    webOrigin: ctx.env.PUBLIC_URL,
    log: (error, message) => ctx.req.log.error({ err: error }, message),
  };
}

async function assertFormView(ctx: Context, tableId: string, viewId?: string) {
  if (!viewId) return;
  const view = await ctx.db
    .selectFrom("views")
    .select("id")
    .where("id", "=", viewId)
    .where("tableId", "=", tableId)
    .where("viewType", "=", "form")
    .where(liveView())
    .executeTakeFirst();
  if (!view) throw new AppError("invalid_automation");
}

/** A saved automation, with its webhook address when one was just made. */
function withAddress(
  ctx: { env: { PUBLIC_URL: string } },
  saved: { id: string; webhookToken?: string },
): { id: string; webhookUrl?: string } {
  return {
    id: saved.id,
    ...(saved.webhookToken
      ? {
          webhookUrl: `${ctx.env.PUBLIC_URL}/hooks/automations/${saved.webhookToken}`,
        }
      : {}),
  };
}

export const automationsRouter = t.router({
  list: procedure
    .input(z.object({ tableId: z.uuid() }))
    .query(({ ctx, input }) =>
      handle(ctx, async () => {
        await guardTable(ctx, input.tableId, "manage");
        return { automations: await listAutomations(ctx.db, input.tableId) };
      }),
    ),
  create: procedure
    .input(createAutomationInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const { user, table } = await guardTable(ctx, input.tableId, "manage");
        await assertAutomation(ctx.db, table, input);
        if (input.trigger.type === "form_submitted") {
          await assertFormView(ctx, table.id, input.trigger.viewId);
        }
        for (const tableId of writtenTables(input.actions)) {
          await guardTable(ctx, tableId, "write");
        }
        return withAddress(
          ctx,
          await saveAutomation(ctx.db, { ...input, createdBy: user.id }),
        );
      }),
    ),
  update: procedure
    .input(updateAutomationInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const tableId = await automationTableId(ctx.db, input.automationId);
        const { user, table } = await guardTable(ctx, tableId, "manage");
        await assertAutomation(ctx.db, table, input);
        if (input.trigger.type === "form_submitted") {
          await assertFormView(ctx, table.id, input.trigger.viewId);
        }
        for (const tableId of writtenTables(input.actions)) {
          await guardTable(ctx, tableId, "write");
        }
        return withAddress(
          ctx,
          await saveAutomation(ctx.db, {
            ...input,
            id: input.automationId,
            tableId,
            createdBy: user.id,
          }),
        );
      }),
    ),
  /** A new secret address for a webhook automation, shown once. */
  renewWebhook: procedure
    .input(z.object({ automationId: z.uuid() }))
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        await guardTable(
          ctx,
          await automationTableId(ctx.db, input.automationId),
          "manage",
        );
        const token = await renewAutomationWebhook(ctx.db, input.automationId);
        return {
          webhookUrl: `${ctx.env.PUBLIC_URL}/hooks/automations/${token}`,
        };
      }),
    ),
  setEnabled: procedure
    .input(z.object({ automationId: z.uuid(), enabled: z.boolean() }))
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        await guardTable(
          ctx,
          await automationTableId(ctx.db, input.automationId),
          "manage",
        );
        await setAutomationEnabled(ctx.db, input.automationId, input.enabled);
        return { ok: true as const };
      }),
    ),
  delete: procedure
    .input(z.object({ automationId: z.uuid() }))
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        await guardTable(
          ctx,
          await automationTableId(ctx.db, input.automationId),
          "manage",
        );
        await deleteAutomation(ctx.db, input.automationId);
        return { ok: true as const };
      }),
    ),
  runs: procedure
    .input(
      z.object({
        automationId: z.uuid(),
        limit: z.int().min(1).max(200).default(50),
      }),
    )
    .query(({ ctx, input }) =>
      handle(ctx, async () => {
        await guardTable(
          ctx,
          await automationTableId(ctx.db, input.automationId),
          "manage",
        );
        return {
          runs: await listRuns(ctx.db, input.automationId, input.limit),
        };
      }),
    ),
  /** Runs an automation now, on one row when given, to try it out. */
  runNow: procedure
    .input(z.object({ automationId: z.uuid(), rowId: z.uuid().optional() }))
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const { user } = await guardTable(
          ctx,
          await automationTableId(ctx.db, input.automationId),
          "manage",
        );
        const automation = await ctx.db
          .selectFrom("automations")
          .selectAll()
          .where("id", "=", input.automationId)
          .executeTakeFirst();
        if (!automation) throw new AppError("no_row");
        return runAutomation(await automationDeps(ctx), automation, {
          rowId: input.rowId,
          depth: 0,
          trigger: "manual",
          triggeredBy: user.id,
        });
      }),
    ),
  /** A click on a button cell that runs automations. */
  pressButton: procedure
    .input(
      z.object({
        tableId: z.uuid(),
        rowId: z.uuid(),
        column: z.string().max(63),
      }),
    )
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const { user, table } = await guardTable(ctx, input.tableId, "write");
        const column = await ctx.db
          .selectFrom("dataColumns")
          .select("fieldType")
          .where("tableId", "=", table.id)
          .where("name", "=", input.column)
          .where(liveColumn())
          .executeTakeFirst();
        if (column?.fieldType !== "button")
          throw new AppError("invalid_automation");
        const results = await pressButton(await automationDeps(ctx), {
          userId: user.id,
          table,
          rowId: input.rowId,
          column: input.column,
        });
        return { results };
      }),
    ),
});
