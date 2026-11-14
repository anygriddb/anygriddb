/**
 * The instance itself: the proof, its settings and identity, its health,
 * its alerts and releases, its jobs and its mail.
 */
import {
  ALERT_CHOICES,
  AppError,
  instanceLogoInputSchema,
  instanceSettingsPatchSchema,
  JOB_STATUSES,
} from "@anygriddb/core";
import { z } from "zod";
import {
  endOtherSessions,
  instanceRuntime,
  listFailedDeliveries,
} from "../admin-control.js";
import { operatorFixedFromEnv } from "../operator-fixed.js";
import { readLogoVersion, removeLogo, saveLogo } from "../instance-logo.js";
import { alertLock } from "../auth/lock-alerts.js";
import { countFailure, lockOf } from "../auth/lockout.js";
import { parseSignInCidr } from "../auth/sign-in-allowlist.js";
import { sendSecurityNotice } from "../auth/security-mail.js";
import { SESSION_COOKIE } from "../auth/session.js";
import { confirmStepUp, stepUpIsFresh, stepUpNeeds } from "../auth/step-up.js";
import { readGateSettings } from "../settings.js";
import { cancelAnyJob, listAllJobs } from "../jobs.js";
import { resolveOidc } from "../integrations/oidc.js";
import { resolveSaml } from "../integrations/saml.js";
import { resolveSmtp } from "../integrations/smtp.js";
import { sendMail, smtpReady } from "../mail.js";
import { testMailBody, testMailSubject } from "../mail-i18n.js";
import {
  operatorMailInputSchema,
  operatorMailRecipientsSchema,
  queueOperatorMail,
  resolveOperatorRecipients,
} from "../operator-mail.js";
import { instanceHealth } from "../admin.js";
import {
  dismissReleaseNotice,
  releaseNotice,
  releaseNotify,
  runReleaseCheck,
  type ReleaseStatus,
} from "../release-status.js";
import { readMailVoice, readSettings, writeSettings } from "../settings.js";
import {
  alertOptOuts,
  listBackups,
  listOpenAlerts,
  setAlertChoice,
} from "../alerts.js";
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
        if (input.ssoOnly === true) {
          const [oidc, saml] = await Promise.all([
            resolveOidc(ctx.db, ctx.env),
            resolveSaml(ctx.db, ctx.env),
          ]);
          if (oidc.config === null && saml.config === null) {
            throw new AppError("sso_required");
          }
        }
        if (input.signInAllowlist) {
          for (const entry of input.signInAllowlist) {
            parseSignInCidr(entry);
          }
        }
        await writeSettings(ctx.db, admin.id, input, ctx.req.ip);
        if (input.maintenance === true) {
          // Only administrators stay: the others are signed out now.
          const ended = await endOtherSessions(ctx.db, admin.id, "non_admins");
          for (const userId of ended) ctx.hub.closeUser(userId);
        }
        ctx.req.log.info(
          { actor: admin.id, keys: Object.keys(input) },
          "instance settings changed",
        );
        return readSettings(ctx.db);
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
      }),
    )
    .query(({ ctx, input }) =>
      handle(ctx, async () => {
        await requireAdmin(ctx);
        return { jobs: await listAllJobs(ctx.db, input) };
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
    .input(z.object({ limit: z.int().min(1).max(200).default(50) }))
    .query(({ ctx, input }) =>
      handle(ctx, async () => {
        await requireAdmin(ctx);
        return { deliveries: await listFailedDeliveries(ctx.db, input.limit) };
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
      await sendMail(smtp, voice, {
        to: admin.email,
        subject: testMailSubject(voice),
        text: testMailBody(voice),
      });
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
