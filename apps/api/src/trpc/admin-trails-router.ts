/**
 * The trails and the reports drawn from them.
 */
import type { AuthAction } from "@anygriddb/db";
import { z } from "zod";
import {
  accessReportCsv,
  auditEventsCsv,
  authEventCount,
  authEventsCsv,
  instanceAuthAudit,
} from "../admin-control.js";
import { recordExport } from "../data/export-audit.js";
import { instanceAudit } from "../admin.js";
import { readSettings } from "../settings.js";
import { handle } from "./guard.js";
import { procedure, requireAdmin, requireSupport } from "./admin-procedure.js";

const auditInputSchema = z.object({
  userId: z.uuid().optional(),
  tableId: z.uuid().optional(),
  action: z
    .enum([
      "insert",
      "update",
      "delete",
      "submit",
      "lock",
      "unlock",
      "sign",
      "catalog",
      "export",
      "purge",
      "access",
    ])
    .optional(),
  source: z.string().trim().max(100).optional(),
  before: z.iso.datetime().optional(),
  limit: z.int().min(1).max(200).default(50),
});

const authActionSchema = z.enum([
  "login_success",
  "login_failure",
  "logout",
  "session_revoked",
  "factors_cleared",
  "tokens_revoked",
  "account_locked",
  "account_unlocked",
  "password_changed",
  "password_reset_requested",
  "password_reset",
  "settings_changed",
  "account_created",
  "account_disabled",
  "account_erased",
  "account_updated",
  "sso_unlinked",
  "operator_mail_sent",
] satisfies AuthAction[]);

const exportLimit = z.int().min(1).max(10_000).default(10_000);

export const adminTrailProcedures = {
  audit: procedure.input(auditInputSchema).query(({ ctx, input }) =>
    handle(ctx, async () => {
      await requireSupport(ctx);
      return instanceAudit(ctx.db, {
        ...input,
        source: input.source || undefined,
      });
    }),
  ),
  /** The sign-in trail (ADR 0042), newest first. */
  authAudit: procedure
    .input(
      z.object({
        userId: z.uuid().optional(),
        action: authActionSchema.optional(),
        before: z.iso.datetime().optional(),
        limit: z.int().min(1).max(200).default(50),
      }),
    )
    .query(({ ctx, input }) =>
      handle(ctx, async () => {
        await requireSupport(ctx);
        const [page, total, settings] = await Promise.all([
          instanceAuthAudit(ctx.db, input),
          authEventCount(ctx.db),
          readSettings(ctx.db),
        ]);
        return { ...page, total, retentionDays: settings.authRetentionDays };
      }),
    ),
  /** CSV downloads of both trails, up to 10,000 events, as filtered. */
  exportAudit: procedure
    .input(auditInputSchema.extend({ limit: exportLimit }))
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireAdmin(ctx);
        const page = await instanceAudit(ctx.db, {
          ...input,
          source: input.source || undefined,
        });
        await recordExport(ctx.db, {
          userId: admin.id,
          source: "web",
          export: {
            kind: "change_trail",
            format: "csv",
            rows: page.events.length,
          },
        });
        ctx.req.log.info({ actor: admin.id }, "audit exported");
        return { csv: auditEventsCsv(page.events) };
      }),
    ),
  exportAuthAudit: procedure
    .input(
      z.object({
        userId: z.uuid().optional(),
        action: authActionSchema.optional(),
        before: z.iso.datetime().optional(),
        limit: exportLimit,
      }),
    )
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireAdmin(ctx);
        const page = await instanceAuthAudit(ctx.db, input);
        await recordExport(ctx.db, {
          userId: admin.id,
          source: "web",
          export: {
            kind: "sign_in_trail",
            format: "csv",
            rows: page.events.length,
          },
        });
        ctx.req.log.info({ actor: admin.id }, "sign-in trail exported");
        return { csv: authEventsCsv(page.events) };
      }),
    ),
  accessReport: procedure.mutation(({ ctx }) =>
    handle(ctx, async () => {
      const admin = await requireAdmin(ctx);
      const csv = await accessReportCsv(ctx.db);
      await recordExport(ctx.db, {
        userId: admin.id,
        source: "web",
        export: { kind: "access_report", format: "csv" },
      });
      ctx.req.log.info({ actor: admin.id }, "access report exported");
      return { csv };
    }),
  ),
};
