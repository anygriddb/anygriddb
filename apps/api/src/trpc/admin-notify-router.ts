/**
 * Notification channels an administrator configures (ADR 0092). Secrets
 * are written and never returned. A test runs in the request so the
 * screen can show the answer; a real event goes through the queue.
 */
import { NOTIFY_PROVIDERS, notifyProviderView } from "@anygriddb/core";
import {
  createIntegration,
  deleteIntegration,
  failingIntegrationCount,
  integrationDeliveries,
  listIntegrations,
  setIntegrationEnabled,
  updateIntegration,
} from "../notify/store.js";
import { testIntegration } from "../notify/dispatch.js";
import { clearMetricsBearer } from "../notify/metrics-token.js";
import { clearSentryDsn } from "../notify/sentry.js";
import { applyTracing, savedTracing } from "../notify/tracing.js";
import { BUILD } from "../build-info.js";
import type { Database } from "@anygriddb/db";
import type { Env } from "../env.js";
import {
  createIntegrationSchema,
  integrationEnabledSchema,
  integrationIdSchema,
  updateIntegrationSchema,
} from "../notify/input.js";
import { handle } from "./guard.js";
import { t } from "./init.js";
import { procedure, requireAdmin } from "./admin-procedure.js";

/** Applies a saved metrics token or collector. True when traces need a restart. */
async function refreshProbe(
  db: Database,
  env: Env,
  provider: string,
): Promise<boolean> {
  if (provider === "metrics") clearMetricsBearer();
  if (provider === "sentry") clearSentryDsn();
  if (provider !== "otlp" || env.OTEL_EXPORTER_OTLP_ENDPOINT) return false;
  const savedTraces = await savedTracing(db, env.AUTH_ENCRYPTION_KEY);
  const tracing = await applyTracing({
    endpoint: savedTraces.endpoint,
    headers: savedTraces.headers,
    serviceName: env.OTEL_SERVICE_NAME,
    version: BUILD.version,
  });
  return tracing === "restart";
}

export const notifyRouter = t.router({
  providers: procedure.query(({ ctx }) =>
    handle(ctx, async () => {
      await requireAdmin(ctx);
      return NOTIFY_PROVIDERS.map(notifyProviderView);
    }),
  ),
  failing: procedure.query(({ ctx }) =>
    handle(ctx, async () => {
      await requireAdmin(ctx);
      return { count: await failingIntegrationCount(ctx.db) };
    }),
  ),
  environment: procedure.query(({ ctx }) =>
    handle(ctx, async () => {
      await requireAdmin(ctx);
      return {
        metrics: Boolean(ctx.env.METRICS_TOKEN),
        traces: Boolean(ctx.env.OTEL_EXPORTER_OTLP_ENDPOINT),
      };
    }),
  ),
  schedules: procedure.query(({ ctx }) =>
    handle(ctx, async () => {
      await requireAdmin(ctx);
      const rows = await ctx.db
        .selectFrom("automations")
        .select(["id", "name"])
        .where("nextRunAt", "is not", null)
        .orderBy("name", "asc")
        .execute();
      return rows.map((row) => ({
        id: `automation:${row.id}`,
        name: row.name,
      }));
    }),
  ),
  list: procedure.query(({ ctx }) =>
    handle(ctx, async () => {
      await requireAdmin(ctx);
      return listIntegrations(ctx.db, ctx.env.AUTH_ENCRYPTION_KEY);
    }),
  ),
  deliveries: procedure.input(integrationIdSchema).query(({ ctx, input }) =>
    handle(ctx, async () => {
      await requireAdmin(ctx);
      return integrationDeliveries(ctx.db, input.id);
    }),
  ),
  create: procedure.input(createIntegrationSchema).mutation(({ ctx, input }) =>
    handle(ctx, async () => {
      const admin = await requireAdmin(ctx);
      const saved = await createIntegration(
        ctx.db,
        ctx.env.AUTH_ENCRYPTION_KEY,
        admin.id,
        input,
        ctx.req.ip,
      );
      ctx.req.log.info(
        { actor: admin.id, integration: saved.id, provider: saved.provider },
        "integration saved",
      );
      return {
        ...saved,
        restartRequired: await refreshProbe(ctx.db, ctx.env, saved.provider),
      };
    }),
  ),
  update: procedure.input(updateIntegrationSchema).mutation(({ ctx, input }) =>
    handle(ctx, async () => {
      const admin = await requireAdmin(ctx);
      const saved = await updateIntegration(
        ctx.db,
        ctx.env.AUTH_ENCRYPTION_KEY,
        admin.id,
        input,
        ctx.req.ip,
      );
      ctx.req.log.info(
        { actor: admin.id, integration: saved.id },
        "integration updated",
      );
      return {
        ...saved,
        restartRequired: await refreshProbe(ctx.db, ctx.env, saved.provider),
      };
    }),
  ),
  setEnabled: procedure
    .input(integrationEnabledSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireAdmin(ctx);
        const saved = await setIntegrationEnabled(
          ctx.db,
          ctx.env.AUTH_ENCRYPTION_KEY,
          admin.id,
          input.id,
          input.enabled,
          ctx.req.ip,
        );
        return {
          ...saved,
          restartRequired: await refreshProbe(ctx.db, ctx.env, saved.provider),
        };
      }),
    ),
  delete: procedure.input(integrationIdSchema).mutation(({ ctx, input }) =>
    handle(ctx, async () => {
      const admin = await requireAdmin(ctx);
      const removed = await deleteIntegration(
        ctx.db,
        admin.id,
        input.id,
        ctx.req.ip,
      );
      ctx.req.log.info(
        { actor: admin.id, integration: removed.id },
        "integration removed",
      );
      return {
        id: removed.id,
        restartRequired: await refreshProbe(ctx.db, ctx.env, removed.provider),
      };
    }),
  ),
  test: procedure.input(integrationIdSchema).mutation(({ ctx, input }) =>
    handle(ctx, async () => {
      await requireAdmin(ctx);
      return testIntegration(
        {
          db: ctx.db,
          key: ctx.env.AUTH_ENCRYPTION_KEY,
          log: (error, message) => ctx.req.log.error({ err: error }, message),
        },
        input.id,
      );
    }),
  ),
});
