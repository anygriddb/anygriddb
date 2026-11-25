/**
 * The instance itself: the proof, its settings and identity, its health,
 * its alerts and releases, its jobs and its mail.
 */
import { refreshProbe } from "./admin-notify-router.js";
import {
  ALERT_CHOICES,
  AppError,
  instanceLogoInputSchema,
  instanceSettingsPatchSchema,
  JOB_STATUSES,
  PERSON_EVENT_CATALOG,
  personChannelsSchema,
  personEventSchema,
} from "@anygriddb/core";
import { z } from "zod";
import { instanceRuntime, listFailedDeliveries } from "../admin-control.js";
import { retryDelivery } from "../outbound/deliveries.js";
import { operatorFixedFromEnv } from "../operator-fixed.js";
import { readLogoVersion, removeLogo, saveLogo } from "../instance-logo.js";
import { alertLock } from "../auth/lock-alerts.js";
import { countFailure, lockOf } from "../auth/lockout.js";
import { sendSecurityNotice } from "../auth/security-mail.js";
import { SESSION_COOKIE } from "../auth/session.js";
import { confirmStepUp, stepUpIsFresh, stepUpNeeds } from "../auth/step-up.js";
import { readGateSettings } from "../settings.js";
import { cancelAnyJob, listAllJobs } from "../jobs.js";
import { resolveOidc } from "../integrations/oidc.js";
import { resolveSaml } from "../integrations/saml.js";
import { resolveSmtp } from "../integrations/smtp.js";
import { sendMail, smtpReady, smtpRefusal } from "../mail.js";
import { testMailBody, testMailSubject } from "../mail-i18n.js";
import {
  operatorMailInputSchema,
  operatorMailRecipientsSchema,
  queueOperatorMail,
  resolveOperatorRecipients,
} from "../operator-mail.js";
import { instanceHealth } from "../admin.js";
import { processLog } from "../process-log.js";
import { readSourceLoad } from "../source-load.js";
import { readUsage } from "../usage-stats.js";
import {
  dismissReleaseNotice,
  releaseNotice,
  releaseNotify,
  runReleaseCheck,
  type ReleaseStatus,
} from "../release-status.js";
import { saveInstanceSettings } from "../instance-settings.js";
import { readMailVoice, readSettings } from "../settings.js";
import {
  alertOptOuts,
  listBackups,
  listOpenAlerts,
  setAlertChoice,
} from "../alerts.js";
import {
  readDefaultChannels,
  saveDefault,
} from "../notify/person-preferences.js";
import type { Context } from "./context.js";
import { handle } from "./guard.js";
import { t } from "./init.js";
import { procedure, requireAdmin, requireSupport } from "./admin-procedure.js";

/**
 * A wrong password or code on a step-up counts toward the lock, as one at
 * sign-in does; a proof left out does not.
 */
async function stepUpFailed(ctx: Context, userId: string): Promise<void> {
  const policy = await readGateSettings(ctx.db);
  if (await countFailure(ctx.db, userId, policy, ctx.req.ip)) {
    const lock = await lockOf(ctx.db, userId, policy);
    const until = lock.locked ? lock.until : null;
    void sendSecurityNotice(
      { db: ctx.db, env: ctx.env, log: ctx.req.log },
      userId,
      { kind: "locked", failures: policy.lockoutThreshold, until },
    );
    await alertLock(
      { db: ctx.db, bus: ctx.bus, env: ctx.env, log: ctx.req.log },
      { userId, failures: policy.lockoutThreshold, until },
    ).catch((error: unknown) => {
      ctx.req.log.error({ err: error }, "lock alert failed");
    });
  }
}

const stepUpProofInput = z
  .object({
    password: z.string().min(1).max(128).optional(),
    factorCode: z.string().min(1).max(64).optional(),
  })
  .strict();

/** A release check as the client reads it. */
function releaseView(status: ReleaseStatus) {
  return { ...status, checkedAt: status.checkedAt.toISOString() };
}

export const adminInstanceProcedures = {
  /**
   * Whether the session's step-up is still fresh, and what proof the page
   * should ask for (ROADMAP #28).
   */
  stepUpStatus: procedure.query(({ ctx }) =>
    handle(ctx, async () => {
      const admin = await requireSupport(ctx);
      const fresh = await stepUpIsFresh(
        ctx.db,
        ctx.req.cookies[SESSION_COOKIE],
      );
      return {
        fresh,
        needs: await stepUpNeeds(ctx.db, admin.id),
        windowMs: 5 * 60_000,
      };
    }),
  ),
  /**
   * Password or second factor for a sensitive Administration action. A
   * wrong proof counts toward the lock; a missing one does not.
   */
  stepUp: procedure.input(stepUpProofInput).mutation(({ ctx, input }) =>
    handle(ctx, async () => {
      const admin = await requireSupport(ctx);
      // A locked account takes no more guesses here than at sign-in: a
      // stolen session must not try passwords without end.
      const policy = await readGateSettings(ctx.db);
      if ((await lockOf(ctx.db, admin.id, policy)).locked) {
        throw new AppError("account_locked");
      }
      const proved = await confirmStepUp(ctx, admin.id, input);
      if (proved === "missing" || proved === "wrong") {
        if (proved === "wrong") await stepUpFailed(ctx, admin.id);
        throw new AppError("invalid_credentials");
      }
      if (proved === "stale") throw new AppError("fresh_sign_in_required");
      return { ok: true as const, windowMs: 5 * 60_000 };
    }),
  ),
  settings: procedure.query(({ ctx }) =>
    handle(ctx, async () => {
      await requireAdmin(ctx);
      const [smtp, oidc, saml] = await Promise.all([
        resolveSmtp(ctx.db, ctx.env),
        resolveOidc(ctx.db, ctx.env),
        resolveSaml(ctx.db, ctx.env),
      ]);
      return {
        ...(await readSettings(ctx.db)),
        // The logo's version, or null: the image itself has its address.
        logo: await readLogoVersion(ctx.db),
        // What some choices depend on: email for resets, SSO for its factor.
        smtpReady: smtpReady(smtp.config),
        ssoReady: oidc.config !== null || saml.config !== null,
      };
    }),
  ),
  /**
   * The instance's logo (ADR 0072), shown wherever the product's mark is.
   * It comes through Administration as any setting does, so that every
   * guard here holds for it; the image is read at its own address.
   */
  setLogo: procedure.input(instanceLogoInputSchema).mutation(({ ctx, input }) =>
    handle(ctx, async () => {
      const admin = await requireAdmin(ctx);
      const version = await saveLogo(ctx.db, admin.id, input.data, ctx.req.ip);
      ctx.req.log.info({ actor: admin.id }, "instance logo set");
      return { logo: version };
    }),
  ),
  removeLogo: procedure.mutation(({ ctx }) =>
    handle(ctx, async () => {
      const admin = await requireAdmin(ctx);
      if (await removeLogo(ctx.db, admin.id, ctx.req.ip)) {
        ctx.req.log.info({ actor: admin.id }, "instance logo removed");
      }
      return { logo: null };
    }),
  ),
  /**
   * What the operator fixed in the environment (public URL, storage,
   * trusted proxies). Read-only; secrets are never included.
   */
  operatorSettings: procedure.query(({ ctx }) =>
    handle(ctx, async () => {
      await requireAdmin(ctx);
      return operatorFixedFromEnv(ctx.env);
    }),
  ),
  updateSettings: procedure
    .input(instanceSettingsPatchSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireAdmin(ctx);
        const saved = await saveInstanceSettings(
          {
            db: ctx.db,
            env: ctx.env,
            closeUser: (userId) => ctx.hub.closeUser(userId),
          },
          { id: admin.id, ip: ctx.req.ip, method: "admin" },
          input,
        );
        // A collector on a private address stops with the switch.
        if (input.notifyAllowPrivate !== undefined) {
          await refreshProbe(ctx.db, ctx.env, "otlp");
        }
        ctx.req.log.info(
          { actor: admin.id, keys: Object.keys(input) },
          "instance settings changed",
        );
        return saved;
      }),
    ),
  /** The certificate served, and the authority to install (ADR 0029). */
  tls: procedure.query(({ ctx }) =>
    handle(ctx, async () => {
      await requireAdmin(ctx);
      return ctx.tls();
    }),
  ),
  health: procedure.query(({ ctx }) =>
    handle(ctx, async () => {
      await requireAdmin(ctx);
      return instanceHealth({ db: ctx.db, bus: ctx.bus, files: ctx.files });
    }),
  ),
  /**
   * Accounts and bases active over 30 days, with a daily trend
   * (ROADMAP #40). Reading also refreshes today's snapshot.
   */
  usage: procedure.query(({ ctx }) =>
    handle(ctx, async () => {
      await requireAdmin(ctx);
      return readUsage(ctx.db);
    }),
  ),
  /**
   * Load by source from persisted minute buckets (ROADMAP #41), never
   * from in-memory Prometheus counters.
   */
  sourceLoad: procedure
    .input(
      z
        .object({
          sinceDays: z
            .union([z.literal(1), z.literal(7), z.literal(30)])
            .default(7),
        })
        .default({ sinceDays: 7 }),
    )
    .query(({ ctx, input }) =>
      handle(ctx, async () => {
        await requireAdmin(ctx);
        return readSourceLoad(ctx.db, input.sinceDays);
      }),
    ),
  /**
   * Recent lines of this process (ADR 0087). A read: administrators and
   * auditors, the same as health. The ring already dropped what a line
   * must not show.
   */
  logs: procedure
    .input(
      z
        .object({
          level: z.enum(["info", "warn", "error"]).default("info"),
          limit: z.int().min(1).max(100).default(50),
          offset: z.int().min(0).max(1_000_000).default(0),
          query: z.string().max(200).optional(),
          from: z.iso.datetime().optional(),
          to: z.iso.datetime().optional(),
          sort: z
            .enum(["time", "level", "message", "request", "address"])
            .default("time"),
          direction: z.enum(["asc", "desc"]).default("desc"),
        })
        .refine((value) => !value.from || !value.to || value.from <= value.to, {
          path: ["from"],
        }),
    )
    .query(({ ctx, input }) =>
      handle(ctx, async () => {
        await requireAdmin(ctx);
        return processLog.list(input);
      }),
    ),
  /**
   * The backups reported and the alerts open now (ROADMAP #17, #25).
   * Reading changes nothing: a scheduled task keeps the alerts in step.
   */
  alerts: procedure.query(({ ctx }) =>
    handle(ctx, async () => {
      await requireAdmin(ctx);
      const [backups, alerts] = await Promise.all([
        listBackups(ctx.db, 10),
        listOpenAlerts(ctx.db),
      ]);
      return { backups, alerts };
    }),
  ),
  /**
   * What the administrator asking is told about (ROADMAP #48): theirs to
   * choose, kind by kind. The alerts stay shown to every administrator.
   */
  alertChoices: t.router({
    get: procedure.query(({ ctx }) =>
      handle(ctx, async () => {
        const admin = await requireAdmin(ctx);
        return { spared: await alertOptOuts(ctx.db, admin.id) };
      }),
    ),
    set: procedure
      .input(z.object({ kind: z.enum(ALERT_CHOICES), receive: z.boolean() }))
      .mutation(({ ctx, input }) =>
        handle(ctx, async () => {
          const admin = await requireAdmin(ctx);
          await setAlertChoice(ctx.db, admin.id, input.kind, input.receive);
          return { ok: true as const };
        }),
      ),
  }),
  /**
   * Instance defaults for person notification preferences (ADR 0123).
   * Each person inherits these until they save their own.
   */
  notificationDefaults: t.router({
    get: procedure.query(({ ctx }) =>
      handle(ctx, async () => {
        await requireAdmin(ctx);
        const defaults = await readDefaultChannels(ctx.db);
        return {
          events: PERSON_EVENT_CATALOG.map((event) => ({
            id: event.id,
            required: [...event.required],
            scoped: event.scoped,
            channels: defaults.get(event.id) ?? [...event.defaults],
          })),
        };
      }),
    ),
    set: procedure
      .input(
        z.object({
          event: personEventSchema,
          channels: personChannelsSchema,
        }),
      )
      .mutation(({ ctx, input }) =>
        handle(ctx, async () => {
          const admin = await requireAdmin(ctx);
          const channels = await saveDefault(
            ctx.db,
            input.event,
            input.channels,
            admin.id,
          );
          return { ok: true as const, channels };
        }),
      ),
  }),
  /**
   * Opt-in check for a newer GitHub Release (ADR 0048). Refused while
   * `releaseCheck` is off so the instance never calls home by default.
   * Persists the result for the Administration banner.
   */
  checkRelease: procedure.mutation(({ ctx }) =>
    handle(ctx, async () => {
      await requireAdmin(ctx);
      const status = await runReleaseCheck(ctx.db);
      return { ...releaseView(status), notify: releaseNotify(true, status) };
    }),
  ),
  /** Last stored release check and whether the update banner should show. */
  releaseStatus: procedure.query(({ ctx }) =>
    handle(ctx, async () => {
      await requireAdmin(ctx);
      const notice = await releaseNotice(ctx.db);
      return {
        status: notice.status ? releaseView(notice.status) : null,
        notify: notice.notify,
      };
    }),
  ),
  /** Hides the update banner for the currently known latest release. */
  dismissRelease: procedure.mutation(({ ctx }) =>
    handle(ctx, async () => {
      await requireAdmin(ctx);
      const status = await dismissReleaseNotice(ctx.db);
      return { ...releaseView(status), notify: false };
    }),
  ),
  jobs: procedure
    .input(
      z.object({
        status: z.enum(JOB_STATUSES).optional(),
        limit: z.int().min(1).max(100).default(50),
        offset: z.int().min(0).max(1_000_000).default(0),
      }),
    )
    .query(({ ctx, input }) =>
      handle(ctx, async () => {
        await requireAdmin(ctx);
        return listAllJobs(ctx.db, input);
      }),
    ),
  cancelJob: procedure
    .input(z.object({ jobId: z.uuid() }))
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireAdmin(ctx);
        await cancelAnyJob(
          {
            db: ctx.db,
            bus: ctx.bus,
            log: (error, message) => ctx.req.log.error({ err: error }, message),
          },
          input.jobId,
        );
        ctx.req.log.info(
          { actor: admin.id, job: input.jobId },
          "job cancelled",
        );
        return { ok: true as const };
      }),
    ),
  failedDeliveries: procedure
    .input(
      z.object({
        limit: z.int().min(1).max(100).default(50),
        offset: z.int().min(0).max(1_000_000).default(0),
        origin: z.enum(["webhook", "integration"]).optional(),
      }),
    )
    .query(({ ctx, input }) =>
      handle(ctx, async () => {
        await requireAdmin(ctx);
        return listFailedDeliveries(ctx.db, input);
      }),
    ),
  /** A delivery that gave up, sent again from its first attempt. */
  retryDelivery: procedure
    .input(z.object({ deliveryId: z.uuid() }))
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireAdmin(ctx);
        await retryDelivery(ctx.db, input.deliveryId);
        ctx.req.log.info(
          { actor: admin.id, delivery: input.deliveryId },
          "delivery retried",
        );
        return { ok: true as const };
      }),
    ),
  /** Sends a test email to the administrator's own address. */
  sendTestMail: procedure.mutation(({ ctx }) =>
    handle(ctx, async () => {
      const admin = await requireAdmin(ctx);
      const { config: smtp } = await resolveSmtp(ctx.db, ctx.env);
      if (!smtpReady(smtp)) throw new AppError("smtp_not_configured");
      // Sent as every mail is: the test shows the sender name and the
      // signature as people will receive them.
      const voice = await readMailVoice(ctx.db);
      try {
        await sendMail(smtp, voice, {
          to: admin.email,
          subject: testMailSubject(voice),
          text: testMailBody(voice),
        });
      } catch (error) {
        // What the relay answered, as saving it says: a relay that offers
        // no encryption is told apart from one that cannot be reached.
        throw new AppError(smtpRefusal(error), {
          cause: error instanceof Error ? error : undefined,
        });
      }
      return { to: admin.email };
    }),
  ),
  /** How many accounts a notice would reach (ADR 0052). */
  operatorMailPreview: procedure
    .input(z.object({ recipients: operatorMailRecipientsSchema }))
    .query(({ ctx, input }) =>
      handle(ctx, async () => {
        await requireAdmin(ctx);
        const people = await resolveOperatorRecipients(
          ctx.db,
          input.recipients,
        );
        return { recipientCount: people.length };
      }),
    ),
  /**
   * Queues a plain-text notice to every active account or to chosen ones
   * (ADR 0052). Delivery runs in the worker; the trail records the send.
   */
  sendOperatorMail: procedure
    .input(operatorMailInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireAdmin(ctx);
        const result = await queueOperatorMail(
          {
            db: ctx.db,
            env: ctx.env,
            actorId: admin.id,
            ip: ctx.req.ip,
          },
          input,
        );
        ctx.req.log.info(
          {
            actor: admin.id,
            recipients: result.recipientCount,
            mode: input.recipients.mode,
          },
          "operator mail queued",
        );
        return result;
      }),
    ),
  /** Health and configuration facts to send to whoever helps the operator. */
  supportBundle: procedure.query(({ ctx }) =>
    handle(ctx, async () => {
      await requireAdmin(ctx);
      const [health, runtime] = await Promise.all([
        instanceHealth({ db: ctx.db, bus: ctx.bus, files: ctx.files }),
        instanceRuntime({
          db: ctx.db,
          env: ctx.env,
          files: ctx.files,
          sources: ctx.sources,
        }),
      ]);
      const tls = ctx.tls();
      return {
        generatedAt: new Date().toISOString(),
        health,
        runtime,
        tls: tls ? { mode: tls.mode, expires: tls.server.expires } : null,
      };
    }),
  ),
};
