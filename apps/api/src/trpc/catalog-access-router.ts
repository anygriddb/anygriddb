/**
 * Who may do what in a base: members, roles, invitations, and the field
 * and row rules of one member.
 */
import {
  ROLES,
  AppError,
  buildCountRows,
  clearTableAclInputSchema,
  effectiveTableRole,
  getTableAclInputSchema,
  setTableAclInputSchema,
  viewAsInputSchema,
} from "@anygriddb/core";
import { z } from "zod";
import { loadBindings } from "../auth/access.js";
import {
  clearTableAcl,
  listTableAcls,
  readerEngine,
  setTableAcl,
} from "../data/acl.js";
import {
  createInvitation,
  assertMemberDomain,
  listInvitations,
  listTableAccess,
  revokeInvitation,
  setTableRole,
} from "../data/sharing.js";
import { readMailVoice } from "../settings.js";
import { listOpenAccess } from "../data/emergency-access.js";
import { invitationMailBody, invitationMailSubject } from "../mail-i18n.js";
import { resolveSmtp } from "../integrations/smtp.js";
import { sendMail, smtpReady } from "../mail.js";
import { loadEngine } from "../data/engine.js";
import {
  grantInputSchema,
  grantMember,
  isMember,
  listMembers,
  membersInputSchema,
  revokeInputSchema,
  revokeMember,
} from "../data/members.js";
import { listGroupRoles, listGroups, setGroupRole } from "../scim/groups.js";
import { readPage, safeTimeZone, visibleFields } from "../data/rows.js";
import { liveColumnNames } from "../data/live.js";
import { guardBase, guardTable, handle } from "./guard.js";
import { procedure } from "./init.js";

export const catalogAccessProcedures = {
  members: procedure.input(membersInputSchema).query(({ ctx, input }) =>
    handle(ctx, async () => {
      await guardBase(ctx, input.baseId, "manage");
      return listMembers(ctx.db, input.baseId);
    }),
  ),
  /**
   * The administrators who have this base open now without being members
   * of it (ADR 0074): who, why, until when. For those who manage the
   * base, beside its members.
   */
  openAccess: procedure.input(membersInputSchema).query(({ ctx, input }) =>
    handle(ctx, async () => {
      await guardBase(ctx, input.baseId, "manage");
      return (await listOpenAccess(ctx.db, input.baseId)).map((open) => ({
        userId: open.userId,
        displayName: open.displayName,
        reason: open.reason,
        expiresAt: open.expiresAt.toISOString(),
      }));
    }),
  ),
  grant: procedure.input(grantInputSchema).mutation(({ ctx, input }) =>
    handle(ctx, async () => {
      const { user } = await guardBase(ctx, input.baseId, "manage");
      await assertMemberDomain(ctx.db, input.email);
      await grantMember(ctx.db, user.id, input);
      return { ok: true as const };
    }),
  ),
  revoke: procedure.input(revokeInputSchema).mutation(({ ctx, input }) =>
    handle(ctx, async () => {
      const { user } = await guardBase(ctx, input.baseId, "manage");
      await revokeMember(ctx.db, user.id, input);
      // Their open sockets reconnect, and the base's channels refuse them.
      ctx.hub.closeUser(input.userId, 4000);
      return { ok: true as const };
    }),
  ),
  /** The groups the base gives a role to, and those it could. */
  groupRoles: procedure.input(membersInputSchema).query(({ ctx, input }) =>
    handle(ctx, async () => {
      await guardBase(ctx, input.baseId, "manage");
      return {
        roles: await listGroupRoles(ctx.db, input.baseId),
        groups: (await listGroups(ctx.db)).map((group) => ({
          id: group.id,
          displayName: group.displayName,
          members: group.members,
        })),
      };
    }),
  ),
  setGroupRole: procedure
    .input(
      z.object({
        baseId: z.uuid(),
        groupId: z.uuid(),
        role: z.enum(ROLES).nullable(),
      }),
    )
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const { user } = await guardBase(ctx, input.baseId, "manage");
        await setGroupRole(ctx.db, user.id, input);
        return { ok: true as const };
      }),
    ),
  tableAccess: procedure
    .input(z.object({ tableId: z.uuid() }))
    .query(({ ctx, input }) =>
      handle(ctx, async () => {
        const { table } = await guardTable(ctx, input.tableId, "manage");
        return { people: await listTableAccess(ctx.db, table) };
      }),
    ),
  setTableRole: procedure
    .input(
      z.object({
        tableId: z.uuid(),
        userId: z.uuid(),
        role: z.enum(["owner", "editor", "commenter", "viewer"]).nullable(),
      }),
    )
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const { user, table } = await guardTable(ctx, input.tableId, "manage");
        await guardBase(ctx, table.baseId, "manage");
        await setTableRole(ctx.db, user.id, table, input.userId, input.role);
        return { ok: true as const };
      }),
    ),
  invite: procedure
    .input(
      z.object({
        baseId: z.uuid(),
        email: z.email().max(254),
        role: z.enum(["owner", "editor", "commenter", "viewer"]),
      }),
    )
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const { user } = await guardBase(ctx, input.baseId, "manage");
        await assertMemberDomain(ctx.db, input.email);
        // Someone already in the base changes role at once: the list of
        // members shows them to whoever manages it.
        if (await isMember(ctx.db, input.baseId, input.email)) {
          await grantMember(ctx.db, user.id, input);
          return { status: "granted" as const, token: null, mailed: false };
        }
        // Anyone else is invited, with an account or without: the answer
        // is the same, so that inviting an address does not tell whether
        // it has an account here. An account's holder finds the
        // invitation on their home page, and the mail's link works too.
        const created = await createInvitation(ctx.db, {
          ...input,
          invitedBy: user.id,
        });
        let mailed = false;
        const { config: smtp } = await resolveSmtp(ctx.db, ctx.env);
        if (smtpReady(smtp)) {
          const [base, voice] = await Promise.all([
            ctx.db
              .selectFrom("bases")
              .select("name")
              .where("id", "=", input.baseId)
              .executeTakeFirst(),
            readMailVoice(ctx.db),
          ]);
          const link = `${ctx.env.PUBLIC_URL}/invite/${created.token}`;
          const expiresDate = created.expiresAt.toISOString().slice(0, 10);
          try {
            await sendMail(smtp, voice, {
              to: input.email,
              subject: invitationMailSubject(voice, base?.name ?? ""),
              text: invitationMailBody(voice, {
                inviterName: user.displayName,
                link,
                expiresDate,
              }),
            });
            mailed = true;
          } catch (error) {
            ctx.req.log.error({ err: error }, "invitation mail failed");
          }
        }
        return { status: "invited" as const, token: created.token, mailed };
      }),
    ),
  invitations: procedure
    .input(z.object({ baseId: z.uuid() }))
    .query(({ ctx, input }) =>
      handle(ctx, async () => {
        await guardBase(ctx, input.baseId, "manage");
        return { invitations: await listInvitations(ctx.db, input.baseId) };
      }),
    ),
  revokeInvitation: procedure
    .input(z.object({ baseId: z.uuid(), invitationId: z.uuid() }))
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        await guardBase(ctx, input.baseId, "manage");
        await revokeInvitation(ctx.db, input.baseId, input.invitationId);
        return { ok: true as const };
      }),
    ),
  /** Field and row rules for every collaborator on a table. */
  tableAcl: procedure.input(getTableAclInputSchema).query(({ ctx, input }) =>
    handle(ctx, async () => {
      await guardTable(ctx, input.tableId, "manage");
      return { rules: await listTableAcls(ctx.db, input.tableId) };
    }),
  ),
  setTableAcl: procedure
    .input(setTableAclInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const { user, table } = await guardTable(ctx, input.tableId, "manage");
        const bindings = await loadBindings(ctx.db, input.userId);
        if (!effectiveTableRole(bindings, table.id, table.baseId)) {
          throw new AppError("unknown_account");
        }
        const known = await liveColumnNames(ctx.db, table.id);
        for (const column of input.columns) {
          if (!known.has(column.column)) throw new AppError("unknown_column");
        }
        if (input.rowFilter) {
          // A rule that does not compile would hide every row: refuse it.
          const { engine } = await loadEngine(ctx.db, table.id, () => true);
          buildCountRows(engine, { filter: input.rowFilter, me: input.userId });
        }
        await setTableAcl(ctx.db, user.id, input);
        return { ok: true as const };
      }),
    ),
  clearTableAcl: procedure
    .input(clearTableAclInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const { user } = await guardTable(ctx, input.tableId, "manage");
        await clearTableAcl(ctx.db, user.id, input.tableId, input.userId);
        return { ok: true as const };
      }),
    ),
  /**
   * A manager's preview of what a collaborator can read: their role, each
   * field's access, their row rule, and a sample page read exactly as they
   * would read it.
   */
  viewAs: procedure.input(viewAsInputSchema).query(({ ctx, input }) =>
    handle(ctx, async () => {
      const { table } = await guardTable(ctx, input.tableId, "manage");
      const target = await ctx.db
        .selectFrom("users")
        .select(["id", "displayName", "email"])
        .where("id", "=", input.userId)
        .executeTakeFirst();
      if (!target) throw new AppError("unknown_account");
      const bindings = await loadBindings(ctx.db, input.userId);
      const role = effectiveTableRole(bindings, table.id, table.baseId);
      if (!role) throw new AppError("access_denied");
      const { engine } = await readerEngine(ctx.db, table.id, {
        userId: input.userId,
        bindings,
      });
      const access = engine.access;
      const columns = engine.table.columns.map((column) => ({
        name: column.name,
        access: access?.hidden(table.id, column.name)
          ? ("hide" as const)
          : access?.readOnly(table.id, column.name)
            ? ("read" as const)
            : ("write" as const),
      }));
      const page = await readPage(
        ctx.db,
        engine,
        {
          ...(engine.access ? { fields: visibleFields(engine) } : {}),
          limit: input.limit,
          timeZone: safeTimeZone(
            typeof ctx.req.headers["x-timezone"] === "string"
              ? ctx.req.headers["x-timezone"]
              : "UTC",
          ),
          me: input.userId,
        },
        { total: true },
      );
      return {
        user: target,
        role,
        rowFilter: access?.rowFilter(table.id) ?? null,
        columns,
        sample: {
          total: page.total ?? 0,
          rows: page.rows,
        },
      };
    }),
  ),
};
