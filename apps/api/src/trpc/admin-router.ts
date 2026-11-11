import {
  AppError,
  instanceSettingsPatchSchema,
  JOB_STATUSES,
  sourceInputSchema,
  sourceUpdateSchema,
} from "@anygriddb/core";
import type { AuthAction } from "@anygriddb/db";
import { z } from "zod";
import {
  accessReportCsv,
  auditEventsCsv,
  authEventCount,
  authEventsCsv,
  adminEraseInputSchema,
  clearFactors,
  endOtherSessions,
  endSession,
  endUserSessions,
  eraseInfo,
  eraseOtherAccount,
  instanceAuthAudit,
  instanceRuntime,
  listFailedDeliveries,
  listPendingInvitations,
  listSessions,
  otherAccount,
  revokeUserTokens,
  unlinkSignOn,
  withdrawInvitation,
} from "../admin-control.js";
import { assertEnrolled } from "../auth/access.js";
import { recordAuthEvent } from "../auth/auth-events.js";
import { unlockAccount } from "../auth/lockout.js";
import { ADMIN_RESET_TTL_MS, createResetLink } from "../auth/password-reset.js";
import {
  resetLinkUrl,
  sendResetLink,
  sendSecurityNotice,
} from "../auth/security-mail.js";
import { cancelAnyJob, listAllJobs } from "../jobs.js";
import {
  clearOidc,
  loadOidcRow,
  publicOidc,
  resolveOidc,
  saveOidc,
  oidcUpdateSchema,
} from "../integrations/oidc.js";
import {
  clearSaml,
  loadSamlRow,
  publicSaml,
  resolveSaml,
  saveSaml,
  samlUpdateSchema,
} from "../integrations/saml.js";
import {
  clearSmtp,
  loadSmtpRow,
  publicSmtp,
  resolveSmtp,
  saveSmtp,
  smtpUpdateSchema,
} from "../integrations/smtp.js";
import { sendMail, smtpReady } from "../mail.js";
import { resolveLocale, testMailBody, testMailSubject } from "../mail-i18n.js";
import {
  operatorMailInputSchema,
  operatorMailRecipientsSchema,
  queueOperatorMail,
  resolveOperatorRecipients,
} from "../operator-mail.js";
import {
  instanceAudit,
  instanceHealth,
  listUsers,
  setUserAdmin,
  setUserDisabled,
  updateAccount,
  updateAccountInputSchema,
} from "../admin.js";
import {
  dismissReleaseNotice,
  releaseNotice,
  releaseNotify,
  runReleaseCheck,
  type ReleaseStatus,
} from "../release-status.js";
import { readSettings, writeSettings } from "../settings.js";
import {
  exposeTables,
  refreshExposedTable,
  setTableWrites,
} from "../sources/expose.js";
import { setTableWatch, watchColumns } from "../sources/watch.js";
import { setTableSync, syncNow } from "../sources/sync.js";
import {
  createSource,
  deleteSource,
  exposedIn,
  listSources,
  recheckSource,
  sourceTables,
  testSource,
  updateSource,
  type SourceDeps,
} from "../sources/sources.js";
import { publishCatalog } from "../realtime/channels.js";
import { listGroups } from "../scim/groups.js";
import {
  createScimToken,
  createScimTokenInputSchema,
  listScimTokens,
  revokeScimToken,
  revokeScimTokenInputSchema,
} from "../scim/tokens.js";
import type { Context } from "./context.js";
import { handle } from "./guard.js";
import { procedure, requestNames, requireUser, t } from "./init.js";

/**
 * Administration needs an admin's own session, API tokens refused, and a
 * second factor, whatever the policy says of others (ADR 0043).
 */
async function requireAdmin(ctx: Context) {
  const user = await requireUser(ctx);
  if (!user.isAdmin || ctx.tokenScope) {
    throw new AppError("access_denied");
  }
  await assertEnrolled(ctx.db, user, []);
  return user;
}

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
  "account_disabled",
  "account_erased",
  "account_updated",
  "sso_unlinked",
  "operator_mail_sent",
] satisfies AuthAction[]);

const exportLimit = z.int().min(1).max(10_000).default(10_000);

function sourceDeps(ctx: Context): SourceDeps {
  return {
    db: ctx.db,
    key: ctx.env.AUTH_ENCRYPTION_KEY,
    settings: ctx.sources,
  };
}

/** A release check as the client reads it. */
function releaseView(status: ReleaseStatus) {
  return { ...status, checkedAt: status.checkedAt.toISOString() };
}

/** Client databases (ADR 0026): declared and checked by administrators. */
const sourcesRouter = t.router({
  settings: procedure.query(({ ctx }) =>
    handle(ctx, async () => {
      await requireAdmin(ctx);
      return {
        allowedHosts: [...ctx.sources.allowedHosts],
        allowPlaintext: ctx.sources.allowPlaintext,
      };
    }),
  ),
  list: procedure.query(({ ctx }) =>
    handle(ctx, async () => {
      await requireAdmin(ctx);
      return listSources(ctx.db);
    }),
  ),
  test: procedure.input(sourceInputSchema).mutation(({ ctx, input }) =>
    handle(ctx, async () => {
      await requireAdmin(ctx);
      return testSource(sourceDeps(ctx), input);
    }),
  ),
  create: procedure.input(sourceInputSchema).mutation(({ ctx, input }) =>
    handle(ctx, async () => {
      const admin = await requireAdmin(ctx);
      const created = await createSource(sourceDeps(ctx), admin.id, input);
      ctx.req.log.info(
        { actor: admin.id, source: created.id },
        "source declared",
      );
      return created;
    }),
  ),
  update: procedure.input(sourceUpdateSchema).mutation(({ ctx, input }) =>
    handle(ctx, async () => {
      const admin = await requireAdmin(ctx);
      return updateSource(sourceDeps(ctx), admin.id, input);
    }),
  ),
  check: procedure
    .input(z.object({ id: z.uuid() }))
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        await requireAdmin(ctx);
        return recheckSource(sourceDeps(ctx), input.id);
      }),
    ),
  expose: procedure
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
        const admin = await requireAdmin(ctx);
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
  setWrites: procedure
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
        const admin = await requireAdmin(ctx);
        const result = await setTableWrites(sourceDeps(ctx), admin.id, input);
        await publishCatalog(ctx.bus, result.baseId, (error) => {
          ctx.req.log.error({ err: error }, "catalog publish failed");
        });
        return result;
      }),
    ),
  refreshTable: procedure
    .input(z.object({ tableId: z.uuid() }))
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireAdmin(ctx);
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
  setWatch: procedure
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
        const admin = await requireAdmin(ctx);
        await setTableWatch(sourceDeps(ctx), admin.id, input);
        return { ok: true as const };
      }),
    ),
  setSync: procedure
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
        const admin = await requireAdmin(ctx);
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
  exposures: procedure
    .input(z.object({ id: z.uuid() }))
    .query(({ ctx, input }) =>
      handle(ctx, async () => {
        await requireAdmin(ctx);
        return Object.fromEntries(await exposedIn(ctx.db, input.id));
      }),
    ),
  syncNow: procedure
    .input(z.object({ tableId: z.uuid() }))
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        await requireAdmin(ctx);
        await syncNow(ctx.db, input.tableId);
        return { ok: true as const };
      }),
    ),
  tables: procedure.input(z.object({ id: z.uuid() })).query(({ ctx, input }) =>
    handle(ctx, async () => {
      await requireAdmin(ctx);
      const [tables, exposed, source] = await Promise.all([
        sourceTables(sourceDeps(ctx), input.id),
        exposedIn(ctx.db, input.id),
        ctx.db
          .selectFrom("sources")
          .select("engine")
          .where("id", "=", input.id)
          .executeTakeFirstOrThrow(),
      ]);
      return tables.map((table) => ({
        ...table,
        changeTracking: table.changeTracking ?? false,
        // Columns that can tell changes made elsewhere (ADR 0031).
        watchColumns: watchColumns(source.engine, table),
        exposedIn: exposed.get(`${table.schema}.${table.name}`) ?? [],
      }));
    }),
  ),
  delete: procedure
    .input(z.object({ id: z.uuid() }))
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireAdmin(ctx);
        await deleteSource(sourceDeps(ctx), admin.id, input.id);
        return { ok: true as const };
      }),
    ),
});

/** Provisioning by an identity provider (SCIM 2.0, ADR 0038). */
const scimRouter = t.router({
  settings: procedure.query(({ ctx }) =>
    handle(ctx, async () => {
      await requireAdmin(ctx);
      return {
        url: `${ctx.env.PUBLIC_URL}/scim/v2`,
        tokens: await listScimTokens(ctx.db),
        groups: await listGroups(ctx.db),
      };
    }),
  ),
  /** A new token, shown once. */
  createToken: procedure
    .input(createScimTokenInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireAdmin(ctx);
        return createScimToken(ctx.db, admin.id, input.name);
      }),
    ),
  revokeToken: procedure
    .input(revokeScimTokenInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireAdmin(ctx);
        await revokeScimToken(ctx.db, admin.id, input.tokenId);
        return { ok: true as const };
      }),
    ),
});

const smtpRouter = t.router({
  get: procedure.query(({ ctx }) =>
    handle(ctx, async () => {
      await requireAdmin(ctx);
      const [row, resolved] = await Promise.all([
        loadSmtpRow(ctx.db),
        resolveSmtp(ctx.db, ctx.env),
      ]);
      return {
        ...publicSmtp(row),
        source: resolved.source,
        ready: smtpReady(resolved.config),
      };
    }),
  ),
  update: procedure.input(smtpUpdateSchema).mutation(({ ctx, input }) =>
    handle(ctx, async () => {
      const admin = await requireAdmin(ctx);
      return saveSmtp(ctx.db, ctx.env.AUTH_ENCRYPTION_KEY, admin.id, input, {
        ip: ctx.req.ip,
      });
    }),
  ),
  clear: procedure.mutation(({ ctx }) =>
    handle(ctx, async () => {
      const admin = await requireAdmin(ctx);
      await clearSmtp(ctx.db, admin.id, ctx.req.ip);
      return { ok: true as const };
    }),
  ),
});

const oidcRouter = t.router({
  get: procedure.query(({ ctx }) =>
    handle(ctx, async () => {
      await requireAdmin(ctx);
      const [row, resolved] = await Promise.all([
        loadOidcRow(ctx.db),
        resolveOidc(ctx.db, ctx.env),
      ]);
      return {
        ...publicOidc(row, ctx.env.PUBLIC_URL),
        source: resolved.source,
        ready: resolved.config !== null,
      };
    }),
  ),
  update: procedure.input(oidcUpdateSchema).mutation(({ ctx, input }) =>
    handle(ctx, async () => {
      const admin = await requireAdmin(ctx);
      return saveOidc(
        ctx.db,
        ctx.env.AUTH_ENCRYPTION_KEY,
        admin.id,
        input,
        ctx.env.PUBLIC_URL,
        { ip: ctx.req.ip },
      );
    }),
  ),
  clear: procedure.mutation(({ ctx }) =>
    handle(ctx, async () => {
      const admin = await requireAdmin(ctx);
      await clearOidc(ctx.db, admin.id, ctx.req.ip);
      return { ok: true as const };
    }),
  ),
});

const samlRouter = t.router({
  get: procedure.query(({ ctx }) =>
    handle(ctx, async () => {
      await requireAdmin(ctx);
      const [row, resolved] = await Promise.all([
        loadSamlRow(ctx.db),
        resolveSaml(ctx.db, ctx.env),
      ]);
      return {
        ...publicSaml(row, ctx.env.PUBLIC_URL),
        source: resolved.source,
        ready: resolved.config !== null,
      };
    }),
  ),
  update: procedure.input(samlUpdateSchema).mutation(({ ctx, input }) =>
    handle(ctx, async () => {
      const admin = await requireAdmin(ctx);
      return saveSaml(ctx.db, admin.id, input, ctx.env.PUBLIC_URL, {
        ip: ctx.req.ip,
      });
    }),
  ),
  clear: procedure.mutation(({ ctx }) =>
    handle(ctx, async () => {
      const admin = await requireAdmin(ctx);
      await clearSaml(ctx.db, admin.id, ctx.req.ip);
      return { ok: true as const };
    }),
  ),
});

export const adminRouter = t.router({
  scim: scimRouter,
  sources: sourcesRouter,
  smtp: smtpRouter,
  oidc: oidcRouter,
  saml: samlRouter,
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
        // What some choices depend on: email for resets, SSO for its factor.
        smtpReady: smtpReady(smtp.config),
        ssoReady: oidc.config !== null || saml.config !== null,
      };
    }),
  ),
  updateSettings: procedure
    .input(instanceSettingsPatchSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireAdmin(ctx);
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
  users: procedure
    .input(
      z.object({
        search: z.string().trim().max(100).optional(),
        offset: z.int().min(0).max(1_000_000).default(0),
        limit: z.int().min(1).max(100).default(50),
      }),
    )
    .query(({ ctx, input }) =>
      handle(ctx, async () => {
        await requireAdmin(ctx);
        return listUsers(ctx.db, {
          ...input,
          search: input.search || undefined,
        });
      }),
    ),
  /**
   * Corrects an account's name or address. The trail names what changed,
   * and the log neither value.
   */
  updateAccount: procedure
    .input(updateAccountInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireAdmin(ctx);
        const changed = await updateAccount(ctx.db, admin.id, input);
        ctx.req.log.info(
          { actor: admin.id, target: input.userId, changed },
          "account updated",
        );
        return { ok: true as const };
      }),
    ),
  setDisabled: procedure
    .input(z.object({ userId: z.uuid(), disabled: z.boolean() }))
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireAdmin(ctx);
        await setUserDisabled(ctx.db, admin.id, input.userId, input.disabled);
        if (input.disabled) ctx.hub.closeUser(input.userId);
        ctx.req.log.info(
          { actor: admin.id, target: input.userId, disabled: input.disabled },
          "account status changed",
        );
        return { ok: true as const };
      }),
    ),
  /**
   * What the erase dialog needs: whether the account may be erased, and
   * which live bases still name it as their only owner (ADR 0051).
   */
  eraseInfo: procedure
    .input(z.object({ userId: z.uuid() }))
    .query(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireAdmin(ctx);
        return eraseInfo(ctx.db, admin.id, input.userId);
      }),
    ),
  /**
   * Erases a disabled account after the administrator types its email.
   * Same tombstone path as self-service erasure (ADR 0051).
   */
  erase: procedure.input(adminEraseInputSchema).mutation(({ ctx, input }) =>
    handle(ctx, async () => {
      const admin = await requireAdmin(ctx);
      await eraseOtherAccount(ctx.db, admin.id, input);
      ctx.hub.closeUser(input.userId);
      ctx.req.log.info(
        { actor: admin.id, target: input.userId },
        "account erased",
      );
      return { ok: true as const };
    }),
  ),
  setAdmin: procedure
    .input(z.object({ userId: z.uuid(), admin: z.boolean() }))
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireAdmin(ctx);
        await setUserAdmin(ctx.db, input.userId, input.admin);
        ctx.req.log.info(
          { actor: admin.id, target: input.userId, admin: input.admin },
          "admin role changed",
        );
        return { ok: true as const };
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
  audit: procedure.input(auditInputSchema).query(({ ctx, input }) =>
    handle(ctx, async () => {
      await requireAdmin(ctx);
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
        await requireAdmin(ctx);
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
        ctx.req.log.info({ actor: admin.id }, "sign-in trail exported");
        return { csv: authEventsCsv(page.events) };
      }),
    ),
  accessReport: procedure.mutation(({ ctx }) =>
    handle(ctx, async () => {
      const admin = await requireAdmin(ctx);
      ctx.req.log.info({ actor: admin.id }, "access report exported");
      return { csv: await accessReportCsv(ctx.db) };
    }),
  ),
  sessions: procedure.query(({ ctx }) =>
    handle(ctx, async () => {
      const admin = await requireAdmin(ctx);
      const sessions = await listSessions(ctx.db);
      return {
        sessions: sessions.map((session) => ({
          ...session,
          mine: session.userId === admin.id,
        })),
      };
    }),
  ),
  endSession: procedure
    .input(z.object({ sessionId: z.uuid() }))
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireAdmin(ctx);
        const { userId } = await endSession(ctx.db, admin.id, input.sessionId);
        ctx.hub.closeUser(userId);
        return { ok: true as const };
      }),
    ),
  endUserSessions: procedure
    .input(z.object({ userId: z.uuid() }))
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireAdmin(ctx);
        if (input.userId === admin.id) throw new AppError("invalid_account");
        const count = await endUserSessions(ctx.db, admin.id, input.userId);
        ctx.hub.closeUser(input.userId);
        return { count };
      }),
    ),
  endOtherSessions: procedure.mutation(({ ctx }) =>
    handle(ctx, async () => {
      const admin = await requireAdmin(ctx);
      const ended = await endOtherSessions(ctx.db, admin.id, "everyone");
      ctx.hub.closeAllBut(admin.id);
      return { count: ended.length };
    }),
  ),
  clearFactors: procedure
    .input(z.object({ userId: z.uuid() }))
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireAdmin(ctx);
        await clearFactors(ctx.db, admin.id, input.userId);
        ctx.hub.closeUser(input.userId);
        void sendSecurityNotice(
          { db: ctx.db, env: ctx.env, log: ctx.req.log },
          input.userId,
          { kind: "factors_removed" },
        );
        return { ok: true as const };
      }),
    ),
  /** Lets an account bind to another provider subject at its next sign-on. */
  unlinkSignOn: procedure
    .input(z.object({ userId: z.uuid() }))
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireAdmin(ctx);
        return { count: await unlinkSignOn(ctx.db, admin.id, input.userId) };
      }),
    ),
  /** Lifts a lock set by failed sign-ins (ADR 0043). */
  unlock: procedure
    .input(z.object({ userId: z.uuid() }))
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireAdmin(ctx);
        await otherAccount(ctx.db, admin.id, input.userId);
        await unlockAccount(ctx.db, admin.id, input.userId);
        return { ok: true as const };
      }),
    ),
  /**
   * A link that lets the person set a new password, valid a day. With email
   * set up it goes to their own address and the administrator never sees
   * it; without, the administrator gets it to pass on (ADR 0043).
   */
  sendPasswordReset: procedure
    .input(z.object({ userId: z.uuid() }))
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireAdmin(ctx);
        await otherAccount(ctx.db, admin.id, input.userId);
        const link = await createResetLink(ctx.db, {
          userId: input.userId,
          createdBy: admin.id,
          ttlMs: ADMIN_RESET_TTL_MS,
        });
        await recordAuthEvent(ctx.db, {
          action: "password_reset_requested",
          userId: input.userId,
          actorId: admin.id,
          method: "admin",
          detail: "reset_link",
          ip: ctx.req.ip,
        });
        if (smtpReady((await resolveSmtp(ctx.db, ctx.env)).config)) {
          const to = await sendResetLink(
            { db: ctx.db, env: ctx.env, log: ctx.req.log },
            input.userId,
            { ...link, byAdmin: true },
          );
          if (!to) throw new AppError("smtp_not_configured");
          return { sent: true as const, to };
        }
        return {
          sent: false as const,
          link: resetLinkUrl(ctx.env.PUBLIC_URL, link.token),
          expiresAt: link.expiresAt.toISOString(),
        };
      }),
    ),
  revokeTokens: procedure
    .input(z.object({ userId: z.uuid() }))
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireAdmin(ctx);
        return {
          count: await revokeUserTokens(ctx.db, admin.id, input.userId),
        };
      }),
    ),
  invitations: procedure.query(({ ctx }) =>
    handle(ctx, async () => {
      await requireAdmin(ctx);
      return { invitations: await listPendingInvitations(ctx.db) };
    }),
  ),
  withdrawInvitation: procedure
    .input(z.object({ invitationId: z.uuid() }))
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireAdmin(ctx);
        await withdrawInvitation(ctx.db, input.invitationId);
        ctx.req.log.info(
          { actor: admin.id, invitation: input.invitationId },
          "invitation withdrawn",
        );
        return { ok: true as const };
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
      const settings = await readSettings(ctx.db);
      const locale = resolveLocale(null, settings.defaultLocale);
      await sendMail(smtp, {
        to: admin.email,
        subject: testMailSubject(locale),
        text: testMailBody(locale),
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
});
