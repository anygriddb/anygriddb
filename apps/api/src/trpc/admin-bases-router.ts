/**
 * Who sees which base: roles given from Administration, invitations,
 * what leaves the instance, and an administrator's own way in.
 */
import { AppError, ROLES } from "@anygriddb/core";
import { z } from "zod";
import {
  listPendingInvitations,
  withdrawInvitation,
} from "../admin-control.js";
import {
  endEmergencyAccess,
  listOpenAccess,
  openEmergencyAccess,
  tellOwners,
  type AccessNoticeDeps,
} from "../data/emergency-access.js";
import { listMembers, revokeMember, setMemberRole } from "../data/members.js";
import { assertMemberDomain, renewInvitation } from "../data/sharing.js";
import { listAllTrashedBases, restoreBase, trashBase } from "../data/trash.js";
import { resolveSmtp } from "../integrations/smtp.js";
import { sendMail, smtpReady } from "../mail.js";
import { invitationMailBody, invitationMailSubject } from "../mail-i18n.js";
import { assertGrantable, listBaseChoices } from "../admin.js";
import { readMailVoice } from "../settings.js";
import { publishCatalog } from "../realtime/channels.js";
import {
  effectiveAccess,
  effectiveAccessInputSchema,
} from "../admin-access.js";
import type { Context } from "./context.js";
import { handle } from "./guard.js";
import { tellOwnersOfRole } from "../data/role-notices.js";
import {
  countOwnerlessBases,
  listBaseOverview,
  listBaseTables,
  listInstanceHooks,
  listInstanceTokens,
  listOutbound,
  revokeOutbound,
} from "../data/outbound.js";
import { revokeApiToken } from "../auth/tokens.js";
import { setAutomationEnabled } from "../automations.js";
import { updateWebhook } from "../webhooks.js";
import { t } from "./init.js";
import { procedure, requireAdmin, roleNoticeDeps } from "./admin-procedure.js";

/** What telling a base's owners needs: the app, and mail when it is set up. */
async function accessNoticeDeps(ctx: Context): Promise<AccessNoticeDeps> {
  const { config: smtp } = await resolveSmtp(ctx.db, ctx.env);
  return {
    db: ctx.db,
    bus: ctx.bus,
    smtp,
    publicUrl: ctx.env.PUBLIC_URL,
    log: (error, message) => ctx.req.log.error({ err: error }, message),
  };
}

export const adminBaseProcedures = {
  /** The instance's bases, to give a person a role on (ADR 0057). */
  /**
   * Gives a person a role on any live base, or changes it, from their
   * account's page (ROADMAP #68, ADR 0057): on the change trail under the
   * administrator's name, the invitation domains holding. A base keeps an
   * owner.
   */
  setBaseRole: procedure
    .input(
      z.object({
        userId: z.uuid(),
        baseId: z.uuid(),
        role: z.enum(ROLES),
        /** Why, when the role is the administrator's own (ADR 0074). */
        reason: z.string().trim().min(1).max(500).optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireAdmin(ctx);
        // A role an administrator gives themselves lets them into a base:
        // it asks a reason, and the owners are told.
        const own = input.userId === admin.id;
        if (own && !input.reason) throw new AppError("reason_required");
        const account = await assertGrantable(ctx.db, input);
        await assertMemberDomain(ctx.db, account.email);
        const { owners, previous } = await setMemberRole(
          ctx.db,
          admin.id,
          input,
          own ? input.reason : undefined,
        );
        if (own && input.reason) {
          const base = await ctx.db
            .selectFrom("bases")
            .select("name")
            .where("id", "=", input.baseId)
            .executeTakeFirst();
          await tellOwners(await accessNoticeDeps(ctx), {
            baseId: input.baseId,
            actorId: admin.id,
            owners,
            notice: {
              mode: "role",
              adminName: admin.displayName,
              baseName: base?.name ?? "",
              reason: input.reason,
              role: input.role,
            },
          });
        } else if (
          previous !== input.role &&
          !(input.role === "owner" && owners.includes(input.userId))
        ) {
          // The owners already there learn who was given which role, and
          // by whom (ROADMAP #15, #91): once, not when it is set again.
          await tellOwnersOfRole(roleNoticeDeps(ctx), {
            baseId: input.baseId,
            actorId: admin.id,
            gift: { to: "person", userId: input.userId, role: input.role },
          });
        }
        ctx.req.log.info(
          {
            actor: admin.id,
            target: input.userId,
            base: input.baseId,
            role: input.role,
          },
          "base role set by administrator",
        );
        return { ok: true as const };
      }),
    ),
  /**
   * Takes a person's own role on a base away; a role a group gives stays.
   * A base keeps an owner.
   */
  removeBaseRole: procedure
    .input(z.object({ userId: z.uuid(), baseId: z.uuid() }))
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireAdmin(ctx);
        await assertGrantable(ctx.db, input);
        await revokeMember(ctx.db, admin.id, input);
        // Their open sockets reconnect, and the base's channels refuse them.
        ctx.hub.closeUser(input.userId, 4000);
        ctx.req.log.info(
          { actor: admin.id, target: input.userId, base: input.baseId },
          "base role removed by administrator",
        );
        return { ok: true as const };
      }),
    ),
  /**
   * Every public link and calendar feed of the instance (ROADMAP #16),
   * metadata only, and revoking one without being in its base.
   */
  outbound: t.router({
    list: procedure.query(({ ctx }) =>
      handle(ctx, async () => {
        await requireAdmin(ctx);
        return { links: await listOutbound(ctx.db, 500) };
      }),
    ),
    revoke: procedure
      .input(z.object({ kind: z.enum(["link", "feed"]), id: z.uuid() }))
      .mutation(({ ctx, input }) =>
        handle(ctx, async () => {
          const admin = await requireAdmin(ctx);
          await revokeOutbound(ctx.db, admin.id, input);
          ctx.req.log.info(
            { actor: admin.id, kind: input.kind, id: input.id },
            "outbound link revoked by administrator",
          );
          return { ok: true as const };
        }),
      ),
  }),
  /**
   * The API tokens, outgoing webhooks, and automations of the whole
   * instance (ROADMAP #23): each with its owner, state, and last use, and
   * one revoked or switched off without being in its base.
   */
  access: t.router({
    list: procedure.query(({ ctx }) =>
      handle(ctx, async () => {
        await requireAdmin(ctx);
        const [tokens, hooks] = await Promise.all([
          listInstanceTokens(ctx.db, 500),
          listInstanceHooks(ctx.db, 500),
        ]);
        return { tokens, hooks };
      }),
    ),
    /**
     * One account's resolved role on a base and each of its tables, with
     * whether it comes from their own binding or a group (ROADMAP #29).
     */
    effective: procedure
      .input(effectiveAccessInputSchema)
      .query(({ ctx, input }) =>
        handle(ctx, async () => {
          await requireAdmin(ctx);
          return effectiveAccess(ctx.db, input);
        }),
      ),
    revokeToken: procedure
      .input(z.object({ id: z.uuid() }))
      .mutation(({ ctx, input }) =>
        handle(ctx, async () => {
          const admin = await requireAdmin(ctx);
          const token = await ctx.db
            .selectFrom("apiTokens")
            .select("userId")
            .where("id", "=", input.id)
            .executeTakeFirst();
          if (!token) throw new AppError("no_row");
          await revokeApiToken(ctx.db, token.userId, input.id);
          ctx.req.log.info(
            { actor: admin.id, target: token.userId, token: input.id },
            "api token revoked by administrator",
          );
          return { ok: true as const };
        }),
      ),
    switchOff: procedure
      .input(
        z.object({ kind: z.enum(["webhook", "automation"]), id: z.uuid() }),
      )
      .mutation(({ ctx, input }) =>
        handle(ctx, async () => {
          const admin = await requireAdmin(ctx);
          if (input.kind === "webhook") {
            await updateWebhook(ctx.db, ctx.env.AUTH_ENCRYPTION_KEY, input.id, {
              active: false,
            });
          } else {
            await setAutomationEnabled(ctx.db, input.id, false);
          }
          ctx.req.log.info(
            { actor: admin.id, kind: input.kind, id: input.id },
            "switched off by administrator",
          );
          return { ok: true as const };
        }),
      ),
  }),
  /**
   * Every base of the instance (ROADMAP #14, #22), with its owners, members,
   * tables, estimated rows, files, and outbound links, metadata only; a
   * page per base; the bases no active account owns; and a base put in
   * the trash or taken out of it without being one of its members.
   */
  baseOverview: t.router({
    list: procedure
      .input(
        z.object({
          search: z.string().trim().max(100).optional(),
          ownerless: z.boolean().optional(),
          limit: z.int().min(1).max(1000).default(500),
        }),
      )
      .query(({ ctx, input }) =>
        handle(ctx, async () => {
          await requireAdmin(ctx);
          return {
            bases: await listBaseOverview(ctx.db, {
              search: input.search || undefined,
              ownerless: input.ownerless,
              limit: input.limit,
            }),
          };
        }),
      ),
    get: procedure
      .input(z.object({ baseId: z.uuid() }))
      .query(({ ctx, input }) =>
        handle(ctx, async () => {
          await requireAdmin(ctx);
          const [base] = await listBaseOverview(ctx.db, {
            baseId: input.baseId,
            limit: 1,
          });
          if (!base) throw new AppError("unknown_base");
          const [members, tables, links, open] = await Promise.all([
            listMembers(ctx.db, input.baseId),
            listBaseTables(ctx.db, input.baseId),
            listOutbound(ctx.db, 200, input.baseId),
            listOpenAccess(ctx.db, input.baseId),
          ]);
          return { base, members, tables, links, open };
        }),
      ),
    /**
     * Opens a base the administrator is not a member of, to read it for
     * an hour (ADR 0074): with a reason, written to the change trail and
     * told to the base's owners. Asking again starts the hour again.
     */
    open: procedure
      .input(
        z.object({
          baseId: z.uuid(),
          reason: z.string().trim().min(1).max(500),
        }),
      )
      .mutation(({ ctx, input }) =>
        handle(ctx, async () => {
          const admin = await requireAdmin(ctx);
          const { expiresAt } = await openEmergencyAccess(
            await accessNoticeDeps(ctx),
            { admin, baseId: input.baseId, reason: input.reason },
          );
          ctx.req.log.info(
            { actor: admin.id, base: input.baseId },
            "base opened by administrator",
          );
          return { expiresAt: expiresAt.toISOString() };
        }),
      ),
    /** Ends the administrator's own opening before its hour is up. */
    close: procedure
      .input(z.object({ baseId: z.uuid() }))
      .mutation(({ ctx, input }) =>
        handle(ctx, async () => {
          const admin = await requireAdmin(ctx);
          const closed = await endEmergencyAccess(ctx.db, {
            userId: admin.id,
            baseId: input.baseId,
          });
          // Their open sockets reconnect, and the base's channels refuse them.
          if (closed) ctx.hub.closeUser(admin.id, 4000);
          return { closed };
        }),
      ),
    /** How many live bases no active account owns. */
    ownerlessCount: procedure.query(({ ctx }) =>
      handle(ctx, async () => {
        await requireAdmin(ctx);
        return { count: await countOwnerlessBases(ctx.db) };
      }),
    ),
    /** The bases in the trash, whoever deleted them. */
    trashed: procedure.query(({ ctx }) =>
      handle(ctx, async () => {
        await requireAdmin(ctx);
        return { items: await listAllTrashedBases(ctx.db, 500) };
      }),
    ),
    /**
     * Puts a base in the trash, under the administrator's name: its
     * owners find it there, and it is purged with the rest when its days
     * are over.
     */
    trash: procedure
      .input(z.object({ baseId: z.uuid() }))
      .mutation(({ ctx, input }) =>
        handle(ctx, async () => {
          const admin = await requireAdmin(ctx);
          await trashBase(ctx.db, admin.id, input.baseId);
          await publishCatalog(ctx.bus, input.baseId, (error) => {
            ctx.req.log.error({ err: error }, "realtime publish failed");
          });
          ctx.req.log.info(
            { actor: admin.id, base: input.baseId },
            "base trashed by administrator",
          );
          return { ok: true as const };
        }),
      ),
    /** Takes a base out of the trash, whoever put it there. */
    restore: procedure
      .input(z.object({ baseId: z.uuid() }))
      .mutation(({ ctx, input }) =>
        handle(ctx, async () => {
          const admin = await requireAdmin(ctx);
          await restoreBase(ctx.db, input.baseId);
          await publishCatalog(ctx.bus, input.baseId, (error) => {
            ctx.req.log.error({ err: error }, "realtime publish failed");
          });
          ctx.req.log.info(
            { actor: admin.id, base: input.baseId },
            "base restored by administrator",
          );
          return { ok: true as const };
        }),
      ),
  }),
  bases: t.router({
    list: procedure
      .input(
        z.object({
          search: z.string().trim().max(100).optional(),
          limit: z.int().min(1).max(200).default(100),
        }),
      )
      .query(({ ctx, input }) =>
        handle(ctx, async () => {
          await requireAdmin(ctx);
          return {
            bases: await listBaseChoices(ctx.db, {
              search: input.search || undefined,
              limit: input.limit,
            }),
          };
        }),
      ),
  }),
  invitations: procedure.query(({ ctx }) =>
    handle(ctx, async () => {
      await requireAdmin(ctx);
      return { invitations: await listPendingInvitations(ctx.db) };
    }),
  ),
  /**
   * A pending invitation sent again with a new link (ROADMAP #20): mailed
   * when email is set up, otherwise handed to the administrator to pass
   * on. The link sent before stops working.
   */
  resendInvitation: procedure
    .input(z.object({ invitationId: z.uuid() }))
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireAdmin(ctx);
        const renewed = await renewInvitation(ctx.db, input.invitationId);
        const link = `${ctx.env.PUBLIC_URL.replace(/\/+$/, "")}/invite/${renewed.token}`;
        const { config: smtp } = await resolveSmtp(ctx.db, ctx.env);
        ctx.req.log.info(
          { actor: admin.id, invitation: input.invitationId },
          "invitation sent again",
        );
        if (!smtpReady(smtp)) {
          return {
            mailed: false as const,
            link,
            expiresAt: renewed.expiresAt.toISOString(),
          };
        }
        const voice = await readMailVoice(ctx.db);
        await sendMail(smtp, voice, {
          to: renewed.email,
          subject: invitationMailSubject(voice, renewed.baseName),
          text: invitationMailBody(voice, {
            inviterName: renewed.inviterName ?? admin.displayName,
            link,
            expiresDate: renewed.expiresAt.toISOString().slice(0, 10),
          }),
        });
        return { mailed: true as const, to: renewed.email };
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
};
