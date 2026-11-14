/**
 * Accounts: who they are, what they may do in Administration, and how
 * they sign in.
 */
import { AppError, PEOPLE_FILE_MAX_BYTES } from "@anygriddb/core";
import { z } from "zod";
import {
  adminEraseInputSchema,
  clearFactors,
  endOtherSessions,
  endSession,
  endUserSessions,
  eraseInfo,
  eraseOtherAccount,
  listSessions,
  otherAccount,
  revokeAllTokens,
  revokeUserTokens,
  unlinkSignOn,
} from "../admin-control.js";
import {
  addPeople,
  bulkDisableInputSchema,
  disableAccounts,
  previewPeople,
} from "../accounts-bulk.js";
import { recordAuthEvent } from "../auth/auth-events.js";
import { unlockAccount } from "../auth/lockout.js";
import {
  ACCOUNT_LINK_TTL_MS,
  ADMIN_RESET_TTL_MS,
  createResetLink,
} from "../auth/password-reset.js";
import {
  resetLinkUrl,
  sendResetLink,
  sendSecurityNotice,
  sendWelcome,
} from "../auth/security-mail.js";
import { resolveSmtp } from "../integrations/smtp.js";
import { smtpReady } from "../mail.js";
import {
  createAccount,
  createAccountInputSchema,
  getAccountDetail,
  listUsers,
  listUsersInputSchema,
  setUserAdmin,
  setUserAuditor,
  setUserDisabled,
  setUserSupport,
  updateAccount,
  updateAccountInputSchema,
} from "../admin.js";
import type { Context } from "./context.js";
import { handle } from "./guard.js";
import { tellOwnersOfRole } from "../data/role-notices.js";
import { handOver, handOverInputSchema, handoffInfo } from "../data/handoff.js";
import { t } from "./init.js";
import {
  procedure,
  requireAdmin,
  roleNoticeDeps,
  requireSupport,
} from "./admin-procedure.js";

/** A gesture that mails people is refused before it starts without mail. */
async function requireMail(ctx: Context): Promise<void> {
  const { config } = await resolveSmtp(ctx.db, ctx.env);
  if (!smtpReady(config)) throw new AppError("smtp_not_configured");
}

const peopleFileInputSchema = z
  .object({ file: z.string().min(1).max(PEOPLE_FILE_MAX_BYTES) })
  .strict();

export const adminAccountProcedures = {
  /** Accounts, searched, filtered, and sorted (ROADMAP #18). */
  users: procedure.input(listUsersInputSchema).query(({ ctx, input }) =>
    handle(ctx, async () => {
      await requireSupport(ctx);
      const [page, smtp] = await Promise.all([
        listUsers(ctx.db, {
          ...input,
          search: input.search || undefined,
        }),
        resolveSmtp(ctx.db, ctx.env),
      ]);
      return { ...page, smtpReady: smtpReady(smtp.config) };
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
   * Several accounts disabled together (ROADMAP #36), each as one is:
   * sessions ended, tokens stopped, the sign-in trail told.
   */
  disableAccounts: procedure
    .input(bulkDisableInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireAdmin(ctx);
        const result = await disableAccounts(ctx.db, admin.id, input.userIds);
        for (const userId of result.disabled) ctx.hub.closeUser(userId);
        ctx.req.log.info(
          {
            actor: admin.id,
            disabled: result.disabled.length,
            refused: result.refused.length,
          },
          "accounts disabled together",
        );
        return {
          disabled: result.disabled.length,
          refused: result.refused.length,
        };
      }),
    ),
  /**
   * The people of a file (ROADMAP #36). `preview` writes nothing; `add`
   * reads the file again and adds the lines in order, never as
   * administrators. Each person's first link goes by mail, so both ask
   * for email to be set up: there is nobody to hand two hundred links to.
   */
  people: t.router({
    preview: procedure.input(peopleFileInputSchema).mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        await requireAdmin(ctx);
        await requireMail(ctx);
        return previewPeople(ctx.db, input.file);
      }),
    ),
    add: procedure.input(peopleFileInputSchema).mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireAdmin(ctx);
        await requireMail(ctx);
        const { given, ...result } = await addPeople(ctx.db, admin, input.file);
        // One notice per base, however many people the file gave a role
        // on it (ROADMAP #91).
        const byBase = new Map<string, typeof given>();
        for (const gift of given) {
          byBase.set(gift.baseId, [...(byBase.get(gift.baseId) ?? []), gift]);
        }
        for (const [baseId, gifts] of byBase) {
          const [only] = gifts;
          await tellOwnersOfRole(roleNoticeDeps(ctx), {
            baseId,
            actorId: admin.id,
            gift:
              gifts.length === 1 && only
                ? { to: "person", userId: only.userId, role: only.role }
                : { to: "people", count: gifts.length },
          });
        }
        ctx.req.log.info(
          {
            actor: admin.id,
            added: result.added,
            refused: result.refused.length,
          },
          "people added from a file",
        );
        return result;
      }),
    ),
  }),
  /**
   * What there is to hand over of a leaving person's (ROADMAP #21): the
   * bases they alone own, the automations and webhooks they made, and
   * how many API tokens they hold. Names only.
   */
  handoffInfo: procedure
    .input(z.object({ userId: z.uuid() }))
    .query(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireAdmin(ctx);
        return handoffInfo(ctx.db, admin.id, input.userId);
      }),
    ),
  /**
   * Hands them to an account that stays. The person's account is left as
   * it is; what the successor may not manage stays with the person, and
   * the answer names it.
   */
  handOver: procedure.input(handOverInputSchema).mutation(({ ctx, input }) =>
    handle(ctx, async () => {
      const admin = await requireAdmin(ctx);
      const result = await handOver(ctx.db, admin.id, input);
      ctx.req.log.info(
        {
          actor: admin.id,
          target: input.fromUserId,
          successor: input.toUserId,
          bases: result.bases,
          automations: result.automations.moved,
          webhooks: result.webhooks.moved,
          tokensRevoked: result.tokensRevoked,
        },
        "account handed over",
      );
      return result;
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
        await setUserAdmin(ctx.db, admin.id, input.userId, input.admin);
        ctx.req.log.info(
          { actor: admin.id, target: input.userId, admin: input.admin },
          "admin role changed",
        );
        return { ok: true as const };
      }),
    ),
  /**
   * Adds a person (ROADMAP #67): an account with no password yet, roles on
   * the bases chosen, and a first link valid a week. With email set up it
   * goes to the person; without, the administrator gets it to pass on.
   */
  createAccount: procedure
    .input(createAccountInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireAdmin(ctx);
        const created = await createAccount(ctx.db, admin.id, input);
        for (const { baseId, role } of input.memberships) {
          await tellOwnersOfRole(roleNoticeDeps(ctx), {
            baseId,
            actorId: admin.id,
            gift: { to: "person", userId: created.id, role },
          });
        }
        const link = await createResetLink(ctx.db, {
          userId: created.id,
          createdBy: admin.id,
          ttlMs: ACCOUNT_LINK_TTL_MS,
        });
        ctx.req.log.info(
          {
            actor: admin.id,
            target: created.id,
            admin: input.admin,
            bases: input.memberships.length,
          },
          "account created by administrator",
        );
        if (smtpReady((await resolveSmtp(ctx.db, ctx.env)).config)) {
          const to = await sendWelcome(
            { db: ctx.db, env: ctx.env, log: ctx.req.log },
            created.id,
            { ...link, creatorName: admin.displayName },
          );
          if (!to) throw new AppError("smtp_not_configured");
          return { userId: created.id, sent: true as const, to };
        }
        return {
          userId: created.id,
          sent: false as const,
          link: resetLinkUrl(ctx.env.PUBLIC_URL, link.token),
          expiresAt: link.expiresAt.toISOString(),
        };
      }),
    ),
  /**
   * One account's page (ROADMAP #19). Support reads it too: it holds no
   * secret, and Support already sees the accounts and their sign-ins.
   */
  account: procedure
    .input(z.object({ userId: z.uuid() }))
    .query(({ ctx, input }) =>
      handle(ctx, async () => {
        await requireSupport(ctx);
        const [account, smtp] = await Promise.all([
          getAccountDetail(ctx.db, input.userId),
          resolveSmtp(ctx.db, ctx.env),
        ]);
        return { ...account, smtpReady: smtpReady(smtp.config) };
      }),
    ),
  setSupport: procedure
    .input(z.object({ userId: z.uuid(), support: z.boolean() }))
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireAdmin(ctx);
        await setUserSupport(ctx.db, admin.id, input.userId, input.support);
        ctx.req.log.info(
          { actor: admin.id, target: input.userId, support: input.support },
          "support role changed",
        );
        return { ok: true as const };
      }),
    ),
  /**
   * Makes an account an auditor, or no longer one (ADR 0071).
   */
  setAuditor: procedure
    .input(z.object({ userId: z.uuid(), auditor: z.boolean() }))
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireAdmin(ctx);
        await setUserAuditor(ctx.db, admin.id, input.userId, input.auditor);
        ctx.req.log.info(
          { actor: admin.id, target: input.userId, auditor: input.auditor },
          "auditor role changed",
        );
        return { ok: true as const };
      }),
    ),
  sessions: procedure.query(({ ctx }) =>
    handle(ctx, async () => {
      const admin = await requireSupport(ctx);
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
        const admin = await requireSupport(ctx);
        const { userId } = await endSession(ctx.db, admin.id, input.sessionId);
        ctx.hub.closeUser(userId);
        return { ok: true as const };
      }),
    ),
  endUserSessions: procedure
    .input(z.object({ userId: z.uuid() }))
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireSupport(ctx);
        if (input.userId === admin.id) throw new AppError("invalid_account");
        const count = await endUserSessions(ctx.db, admin.id, input.userId);
        ctx.hub.closeUser(input.userId);
        return { count };
      }),
    ),
  endOtherSessions: procedure.mutation(({ ctx }) =>
    handle(ctx, async () => {
      const admin = await requireSupport(ctx);
      const ended = await endOtherSessions(ctx.db, admin.id, "everyone");
      ctx.hub.closeAllBut(admin.id);
      return { count: ended.length };
    }),
  ),
  clearFactors: procedure
    .input(z.object({ userId: z.uuid() }))
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireSupport(ctx);
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
        const admin = await requireSupport(ctx);
        return { count: await unlinkSignOn(ctx.db, admin.id, input.userId) };
      }),
    ),
  /** Lifts a lock set by failed sign-ins (ADR 0043). */
  unlock: procedure
    .input(z.object({ userId: z.uuid() }))
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireSupport(ctx);
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
        const admin = await requireSupport(ctx);
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
        const admin = await requireSupport(ctx);
        return {
          count: await revokeUserTokens(ctx.db, admin.id, input.userId),
        };
      }),
    ),
  /** Every API token of the instance, revoked at once (ROADMAP #24). */
  revokeAllTokens: procedure.mutation(({ ctx }) =>
    handle(ctx, async () => {
      const admin = await requireAdmin(ctx);
      const count = await revokeAllTokens(ctx.db, admin.id);
      ctx.req.log.info({ actor: admin.id, count }, "every API token revoked");
      return { count };
    }),
  ),
};
