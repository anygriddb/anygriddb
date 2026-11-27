/**
 * Who sees which base: roles given from Administration, invitations,
 * what leaves the instance, and an administrator's own way in.
 */
import { AppError, givenRoleSchema, trimEndRun } from "@anygriddb/core";
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
import { givenKey, givenName, resolveGiven } from "../data/made-roles.js";
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
import { rightsAt, rightsAtCsv, rightsAtLabels } from "../data/rights-at.js";
import type { Context } from "./context.js";
import { handle } from "./guard.js";
import { tellOwnersOfRole } from "../data/role-notices.js";
import {
  countOwnerlessBases,
  listBaseOverview,
  listBaseTables,
  listInstanceHooks,
} from "../data/outbound.js";
import { listAccesses, revokeAccess } from "../data/accesses.js";
import { setAutomationEnabled } from "../automations.js";
import { updateWebhook } from "../webhooks.js";
import { t } from "./init.js";
import { asking, requireInstance, roleNoticeDeps } from "./admin-procedure.js";

/** What telling a base's owners needs: the app, and mail when it is set up. */
async function accessNoticeDeps(ctx: Context): Promise<AccessNoticeDeps> {
  const { config: smtp } = await resolveSmtp(ctx.db, ctx.env);
  return {
    db: ctx.db,
    bus: ctx.bus,
    smtp,
    publicUrl: ctx.env.PUBLIC_URL,
    log: (error, message) => ctx.req.log.error({ err: error }, message),
    keys: ctx.env.AUTH_ENCRYPTION_KEY,
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
  setBaseRole: asking({ asks: ["access.grant"] })
    .input(
      z.object({
        userId: z.uuid(),
        baseId: z.uuid(),
        role: givenRoleSchema,
        /** Why, when the role is the administrator's own (ADR 0074). */
        reason: z.string().trim().min(1).max(500).optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireInstance(ctx);
        // A role an administrator gives themselves lets them into a base:
        // it asks a reason, and the owners are told.
        const own = input.userId === admin.id;
        if (own && !input.reason) throw new AppError("reason_required");
        const account = await assertGrantable(ctx.db, input);
        await assertMemberDomain(ctx.db, account.email);
        const role = await resolveGiven(ctx.db, input.role);
        const { owners, previous } = await setMemberRole(
          ctx.db,
          admin.id,
          { ...input, role },
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
              role: givenName(role),
            },
          });
        } else if (
          givenKey(previous) !== input.role &&
          !(input.role === "owner" && owners.includes(input.userId))
        ) {
          // The owners already there learn who was given which role, and
          // by whom (ROADMAP #15, #91): once, not when it is set again.
          await tellOwnersOfRole(await roleNoticeDeps(ctx), {
            baseId: input.baseId,
            actorId: admin.id,
            gift: { to: "person", userId: input.userId, role },
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
  removeBaseRole: asking({ asks: ["access.grant"] })
    .input(z.object({ userId: z.uuid(), baseId: z.uuid() }))
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireInstance(ctx);
        await assertGrantable(ctx.db, input);
        await revokeMember(ctx.db, admin.id, input);
        ctx.req.log.info(
          { actor: admin.id, target: input.userId, base: input.baseId },
          "base role removed by administrator",
        );
        return { ok: true as const };
      }),
    ),
  /**
   * Everything that reaches the instance without a session (ADR 0131,
   * §5): every delegated access by its author, reach, end, last use and
   * state, then the outgoing webhooks and the automations, which act as
   * their authors (ROADMAP #16, #23). Metadata only; each stopped without
   * being in its base.
   */
  access: t.router({
    list: asking({ asks: ["access.oversee"] })
      .input(
        z.object({
          limit: z.int().min(1).max(100).default(50),
          offset: z.int().min(0).max(1_000_000).default(0),
          /** Revoked ones too. */
          revoked: z.boolean().default(false),
        }),
      )
      .query(({ ctx, input }) =>
        handle(ctx, async () => {
          await requireInstance(ctx);
          return listAccesses(ctx.db, input);
        }),
      ),
    hooks: asking({ asks: ["access.oversee"] })
      .input(
        z.object({
          limit: z.int().min(1).max(100).default(50),
          webhooksOffset: z.int().min(0).max(1_000_000).default(0),
          automationsOffset: z.int().min(0).max(1_000_000).default(0),
        }),
      )
      .query(({ ctx, input }) =>
        handle(ctx, async () => {
          await requireInstance(ctx);
          const page = { limit: input.limit };
          return listInstanceHooks(ctx.db, {
            webhooks: { ...page, offset: input.webhooksOffset },
            automations: { ...page, offset: input.automationsOffset },
          });
        }),
      ),
    /**
     * One account's resolved role on a base and each of its tables, with
     * whether it comes from their own binding or a group (ROADMAP #29).
     */
    effective: asking({ asks: ["access.oversee"] })
      .input(effectiveAccessInputSchema)
      .query(({ ctx, input }) =>
        handle(ctx, async () => {
          await requireInstance(ctx);
          return effectiveAccess(ctx.db, input);
        }),
      ),
    /**
     * A person's roles as of a chosen date, rebuilt backward from what
     * they hold now (own bindings and those a group gives). Incomplete
     * when the trail was purged before that date.
     */
    rightsAt: asking({ asks: ["access.oversee"] })
      .input(
        z.object({
          userId: z.uuid(),
          at: z.iso.datetime(),
        }),
      )
      .query(({ ctx, input }) =>
        handle(ctx, async () => {
          await requireInstance(ctx);
          const report = await rightsAt(ctx.db, {
            userId: input.userId,
            at: new Date(input.at),
          });
          if (report.incomplete) return report;
          const labels = await rightsAtLabels(ctx.db, report.lines);
          return {
            ...report,
            lines: report.lines.map((line) => ({
              ...line,
              baseName: labels.get(line.scopeId)?.base ?? null,
              tableName: labels.get(line.scopeId)?.table ?? null,
            })),
          };
        }),
      ),
    exportRightsAt: asking({ asks: ["access.oversee"] })
      .input(
        z.object({
          userId: z.uuid(),
          at: z.iso.datetime(),
        }),
      )
      .query(({ ctx, input }) =>
        handle(ctx, async () => {
          await requireInstance(ctx);
          const report = await rightsAt(ctx.db, {
            userId: input.userId,
            at: new Date(input.at),
          });
          if (report.incomplete) {
            return { incomplete: true as const, report };
          }
          const labels = await rightsAtLabels(ctx.db, report.lines);
          return {
            incomplete: false as const,
            csv: rightsAtCsv(report, labels),
          };
        }),
      ),
    revoke: asking({ asks: ["access.oversee"] })
      .input(z.object({ id: z.uuid() }))
      .mutation(({ ctx, input }) =>
        handle(ctx, async () => {
          const admin = await requireInstance(ctx);
          const kind = await revokeAccess(ctx.db, admin.id, input.id);
          ctx.req.log.info(
            { actor: admin.id, kind, access: input.id },
            "access revoked by administrator",
          );
          return { ok: true as const };
        }),
      ),
    switchOff: asking({ asks: ["access.oversee"] })
      .input(
        z.object({ kind: z.enum(["webhook", "automation"]), id: z.uuid() }),
      )
      .mutation(({ ctx, input }) =>
        handle(ctx, async () => {
          const admin = await requireInstance(ctx);
          if (input.kind === "webhook") {
            await updateWebhook(
              ctx.db,
              ctx.env.AUTH_ENCRYPTION_KEY,
              admin.id,
              input.id,
              { active: false },
            );
          } else {
            await setAutomationEnabled(ctx.db, admin.id, input.id, false);
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
    list: asking({ asks: ["bases.oversee"] })
      .input(
        z.object({
          search: z.string().trim().max(100).optional(),
          ownerless: z.boolean().optional(),
          limit: z.int().min(1).max(100).default(50),
          offset: z.int().min(0).max(1_000_000).default(0),
        }),
      )
      .query(({ ctx, input }) =>
        handle(ctx, async () => {
          await requireInstance(ctx);
          return listBaseOverview(ctx.db, {
            search: input.search || undefined,
            ownerless: input.ownerless,
            limit: input.limit,
            offset: input.offset,
          });
        }),
      ),
    get: asking({ asks: ["bases.oversee"] })
      .input(z.object({ baseId: z.uuid() }))
      .query(({ ctx, input }) =>
        handle(ctx, async () => {
          await requireInstance(ctx);
          const { bases } = await listBaseOverview(ctx.db, {
            baseId: input.baseId,
            limit: 1,
          });
          const base = bases[0];
          if (!base) throw new AppError("unknown_base");
          const [members, tables, outbound, open] = await Promise.all([
            listMembers(ctx.db, input.baseId),
            listBaseTables(ctx.db, input.baseId),
            listAccesses(ctx.db, { limit: 100, baseId: input.baseId }),
            listOpenAccess(ctx.db, input.baseId),
          ]);
          return {
            base,
            members,
            tables,
            accesses: outbound.accesses,
            open,
          };
        }),
      ),
    /**
     * Opens a base the administrator is not a member of, to read it for
     * an hour (ADR 0074): with a reason, written to the change trail and
     * told to the base's owners. Asking again starts the hour again.
     */
    open: asking({ asks: ["bases.oversee"] })
      .input(
        z.object({
          baseId: z.uuid(),
          reason: z.string().trim().min(1).max(500),
        }),
      )
      .mutation(({ ctx, input }) =>
        handle(ctx, async () => {
          const admin = await requireInstance(ctx);
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
    close: asking({ asks: ["bases.oversee"] })
      .input(z.object({ baseId: z.uuid() }))
      .mutation(({ ctx, input }) =>
        handle(ctx, async () => {
          const admin = await requireInstance(ctx);
          const closed = await endEmergencyAccess(ctx.db, {
            userId: admin.id,
            baseId: input.baseId,
          });
          return { closed };
        }),
      ),
    /** How many live bases no active account owns. */
    ownerlessCount: asking({ asks: ["bases.oversee"] }).query(({ ctx }) =>
      handle(ctx, async () => {
        await requireInstance(ctx);
        return { count: await countOwnerlessBases(ctx.db) };
      }),
    ),
    /** The bases in the trash, whoever deleted them. */
    trashed: asking({ asks: ["bases.oversee"] }).query(({ ctx }) =>
      handle(ctx, async () => {
        await requireInstance(ctx);
        return { items: await listAllTrashedBases(ctx.db, 500) };
      }),
    ),
    /**
     * Puts a base in the trash, under the administrator's name: its
     * owners find it there, and it is purged with the rest when its days
     * are over.
     */
    trash: asking({ asks: ["bases.oversee"] })
      .input(z.object({ baseId: z.uuid() }))
      .mutation(({ ctx, input }) =>
        handle(ctx, async () => {
          const admin = await requireInstance(ctx);
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
    restore: asking({ asks: ["bases.oversee"] })
      .input(z.object({ baseId: z.uuid() }))
      .mutation(({ ctx, input }) =>
        handle(ctx, async () => {
          const admin = await requireInstance(ctx);
          await restoreBase(ctx.db, admin.id, input.baseId);
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
    list: asking({ asks: ["bases.oversee"] })
      .input(
        z.object({
          search: z.string().trim().max(100).optional(),
          limit: z.int().min(1).max(200).default(100),
        }),
      )
      .query(({ ctx, input }) =>
        handle(ctx, async () => {
          await requireInstance(ctx);
          return {
            bases: await listBaseChoices(ctx.db, {
              search: input.search || undefined,
              limit: input.limit,
            }),
          };
        }),
      ),
  }),
  invitations: asking({ asks: ["bases.oversee"] }).query(({ ctx }) =>
    handle(ctx, async () => {
      await requireInstance(ctx);
      return { invitations: await listPendingInvitations(ctx.db) };
    }),
  ),
  /**
   * A pending invitation sent again with a new link (ROADMAP #20): mailed
   * when email is set up, otherwise handed to the administrator to pass
   * on. The link sent before stops working.
   */
  resendInvitation: asking({ asks: ["bases.oversee"] })
    .input(z.object({ invitationId: z.uuid() }))
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireInstance(ctx);
        const renewed = await renewInvitation(
          ctx.db,
          admin.id,
          input.invitationId,
        );
        const link = `${trimEndRun(ctx.env.PUBLIC_URL, "/")}/invite/${renewed.token}`;
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
  withdrawInvitation: asking({ asks: ["bases.oversee"] })
    .input(z.object({ invitationId: z.uuid() }))
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireInstance(ctx);
        await withdrawInvitation(ctx.db, admin.id, input.invitationId);
        ctx.req.log.info(
          { actor: admin.id, invitation: input.invitationId },
          "invitation withdrawn",
        );
        return { ok: true as const };
      }),
    ),
};
