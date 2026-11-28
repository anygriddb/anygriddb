/**
 * Who may do what in a base: members, roles, invitations, and the field
 * and row rules of one member or group.
 */
import {
  aclSubjectOf,
  AppError,
  checkFilter,
  filterAttributes,
  givenRoleSchema,
  clearTableAclInputSchema,
  effectiveTableRole,
  getTableAclInputSchema,
  type Grant,
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
  assertKnownAttributes,
  attributeChoices,
} from "../data/person-attributes.js";
import {
  grantInputSchema,
  grantMember,
  isMember,
  listMembers,
  membersInputSchema,
  revokeInputSchema,
  revokeMember,
  splitBaseRole,
} from "../data/members.js";
import { listGroupRoles, listGroups, setGroupRole } from "../scim/groups.js";
import { readPage, safeTimeZone, visibleFields } from "../data/rows.js";
import { liveColumnNames } from "../data/live.js";
import {
  assertMayTouch,
  givenBy,
  groupGiven,
  invitationGiven,
  madeRoleChoices,
  ownGiven,
} from "../data/made-roles.js";
import { authorize, guardBase, guardTable, handle } from "./guard.js";
import type { Context } from "./context.js";
import { asking } from "./init.js";

/** A member whose own role is beyond the giver's keeps it (ADR 0128). */
async function assertMayTouchMember(
  ctx: Context,
  giver: Grant,
  baseId: string,
  email: string,
): Promise<void> {
  const account = await ctx.db
    .selectFrom("users")
    .select("id")
    .where("email", "=", email.toLowerCase())
    .executeTakeFirst();
  if (account) {
    assertMayTouch(giver, await ownGiven(ctx.db, account.id, "base", baseId));
  }
}

export const catalogAccessProcedures = {
  /**
   * The roles an administrator made (ADR 0128), which a base gives beside
   * the four: their names and what each gives, to choose from.
   */
  madeRoles: asking({ exception: "ownBases" }).query(({ ctx }) =>
    handle(ctx, async () => {
      await authorize(ctx);
      return {
        roles: (await madeRoleChoices(ctx.db)).map((role) => ({
          id: role.id,
          name: role.name,
          permissions: [...role.permissions],
        })),
      };
    }),
  ),
  /**
   * The attributes of a person a rule may name (ADR 0142), to choose from:
   * their keys and labels, never anyone's values.
   */
  personAttributes: asking({ exception: "ownBases" }).query(({ ctx }) =>
    handle(ctx, async () => {
      await authorize(ctx);
      return { attributes: await attributeChoices(ctx.db) };
    }),
  ),
  members: asking({ asks: ["members.manage"] })
    .input(membersInputSchema)
    .query(({ ctx, input }) =>
      handle(ctx, async () => {
        await guardBase(ctx, input.baseId, "members.manage");
        return listMembers(ctx.db, input.baseId);
      }),
    ),
  /**
   * The administrators who have this base open now without being members
   * of it (ADR 0074): who, why, until when. For those who manage the
   * base, beside its members.
   */
  openAccess: asking({ asks: ["members.manage"] })
    .input(membersInputSchema)
    .query(({ ctx, input }) =>
      handle(ctx, async () => {
        await guardBase(ctx, input.baseId, "members.manage");
        return (await listOpenAccess(ctx.db, input.baseId)).map((open) => ({
          userId: open.userId,
          displayName: open.displayName,
          reason: open.reason,
          expiresAt: open.expiresAt.toISOString(),
        }));
      }),
    ),
  /**
   * Changes the role of someone the base already counts: whoever manages
   * it sees its members. Any other address is refused alike, with an
   * account or without, and is invited instead (`invite`): giving a role
   * at once to an address that has an account told that it has one.
   */
  grant: asking({ asks: ["members.manage"] })
    .input(grantInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const { user, role } = await guardBase(
          ctx,
          input.baseId,
          "members.manage",
        );
        await assertMemberDomain(ctx.db, input.email);
        if (!(await isMember(ctx.db, input.baseId, input.email))) {
          throw new AppError("not_a_member");
        }
        await assertMayTouchMember(ctx, role, input.baseId, input.email);
        await grantMember(ctx.db, user.id, {
          ...input,
          role: await givenBy(ctx.db, role, input.role),
        });
        return { ok: true as const };
      }),
    ),
  revoke: asking({ asks: ["members.manage"] })
    .input(revokeInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const { user, role } = await guardBase(
          ctx,
          input.baseId,
          "members.manage",
        );
        assertMayTouch(
          role,
          await ownGiven(ctx.db, input.userId, "base", input.baseId),
        );
        await revokeMember(ctx.db, user.id, input);
        return { ok: true as const };
      }),
    ),
  /**
   * Someone's own role on the base, given table by table instead (ADR
   * 0131), so that a rule may narrow one table alone.
   */
  splitBaseRole: asking({ asks: ["members.manage"] })
    .input(revokeInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const { user, role } = await guardBase(
          ctx,
          input.baseId,
          "members.manage",
        );
        assertMayTouch(
          role,
          await ownGiven(ctx.db, input.userId, "base", input.baseId),
        );
        await splitBaseRole(ctx.db, user.id, input);
        return { ok: true as const };
      }),
    ),
  /** The groups the base gives a role to, and those it could. */
  groupRoles: asking({ asks: ["members.manage"] })
    .input(membersInputSchema)
    .query(({ ctx, input }) =>
      handle(ctx, async () => {
        await guardBase(ctx, input.baseId, "members.manage");
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
  setGroupRole: asking({ asks: ["members.manage"] })
    .input(
      z.object({
        baseId: z.uuid(),
        groupId: z.uuid(),
        role: givenRoleSchema.nullable(),
      }),
    )
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const { user, role } = await guardBase(
          ctx,
          input.baseId,
          "members.manage",
        );
        assertMayTouch(
          role,
          await groupGiven(ctx.db, input.groupId, "base", input.baseId),
        );
        await setGroupRole(ctx.db, user.id, {
          ...input,
          role: input.role ? await givenBy(ctx.db, role, input.role) : null,
        });
        return { ok: true as const };
      }),
    ),
  tableAccess: asking({ asks: ["members.manage"] })
    .input(z.object({ tableId: z.uuid() }))
    .query(({ ctx, input }) =>
      handle(ctx, async () => {
        const { table } = await guardTable(
          ctx,
          input.tableId,
          "members.manage",
        );
        return listTableAccess(ctx.db, table);
      }),
    ),
  /**
   * Gives a person or a group a role on a table, which adds to what its
   * base gives, or takes it away (`role` null) with its rules.
   */
  setTableRole: asking({ asks: ["members.manage"] })
    .input(
      z.union([
        z
          .object({
            tableId: z.uuid(),
            userId: z.uuid(),
            role: givenRoleSchema.nullable(),
          })
          .strict(),
        z
          .object({
            tableId: z.uuid(),
            groupId: z.uuid(),
            role: givenRoleSchema.nullable(),
          })
          .strict(),
      ]),
    )
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const { user, table, role } = await guardTable(
          ctx,
          input.tableId,
          "members.manage",
        );
        await guardBase(ctx, table.baseId, "members.manage");
        const subject = aclSubjectOf(input);
        assertMayTouch(
          role,
          "userId" in subject
            ? await ownGiven(ctx.db, subject.userId, "table", table.id)
            : await groupGiven(ctx.db, subject.groupId, "table", table.id),
        );
        await setTableRole(
          ctx.db,
          user.id,
          table,
          subject,
          input.role ? await givenBy(ctx.db, role, input.role) : null,
        );
        return { ok: true as const };
      }),
    ),
  invite: asking({ asks: ["members.manage"] })
    .input(
      z.object({
        baseId: z.uuid(),
        email: z.email().max(254),
        role: givenRoleSchema,
      }),
    )
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const { user, role } = await guardBase(
          ctx,
          input.baseId,
          "members.manage",
        );
        await assertMemberDomain(ctx.db, input.email);
        const given = await givenBy(ctx.db, role, input.role);
        // Someone already in the base changes role at once: the list of
        // members shows them to whoever manages it.
        if (await isMember(ctx.db, input.baseId, input.email)) {
          await assertMayTouchMember(ctx, role, input.baseId, input.email);
          await grantMember(ctx.db, user.id, { ...input, role: given });
          return { status: "granted" as const, token: null, mailed: false };
        }
        // Anyone else is invited, with an account or without: the answer
        // is the same, so that inviting an address does not tell whether
        // it has an account here. An account's holder finds the
        // invitation on their home page, and the mail's link works too.
        const created = await createInvitation(ctx.db, {
          ...input,
          role: given,
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
  invitations: asking({ asks: ["members.manage"] })
    .input(z.object({ baseId: z.uuid() }))
    .query(({ ctx, input }) =>
      handle(ctx, async () => {
        await guardBase(ctx, input.baseId, "members.manage");
        return { invitations: await listInvitations(ctx.db, input.baseId) };
      }),
    ),
  revokeInvitation: asking({ asks: ["members.manage"] })
    .input(z.object({ baseId: z.uuid(), invitationId: z.uuid() }))
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const { user, role } = await guardBase(
          ctx,
          input.baseId,
          "members.manage",
        );
        // An invitation offers a role: only one who could give it takes
        // it back (ADR 0128).
        assertMayTouch(
          role,
          await invitationGiven(ctx.db, input.invitationId, input.baseId),
        );
        await revokeInvitation(
          ctx.db,
          user.id,
          input.baseId,
          input.invitationId,
        );
        return { ok: true as const };
      }),
    ),
  /** Field and row rules for every collaborator and group on a table. */
  tableAcl: asking({ asks: ["members.manage"] })
    .input(getTableAclInputSchema)
    .query(({ ctx, input }) =>
      handle(ctx, async () => {
        await guardTable(ctx, input.tableId, "members.manage");
        return { rules: await listTableAcls(ctx.db, input.tableId) };
      }),
    ),
  setTableAcl: asking({ asks: ["members.manage"] })
    .input(setTableAclInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const { user, table } = await guardTable(
          ctx,
          input.tableId,
          "members.manage",
        );
        // A group's rule is checked against the role it narrows, there.
        if ("userId" in input) {
          const bindings = await loadBindings(ctx.db, input.userId);
          if (!effectiveTableRole(bindings, table.id, table.baseId)) {
            throw new AppError("unknown_account");
          }
        }
        const known = await liveColumnNames(ctx.db, table.id);
        for (const column of input.columns) {
          if (!known.has(column.column)) throw new AppError("unknown_column");
        }
        // A rule names only the attributes the instance knows (ADR 0142).
        if (input.rowFilter) {
          await assertKnownAttributes(
            ctx.db,
            filterAttributes(input.rowFilter),
          );
        }
        if (input.rowFilter) {
          // A rule kept is one that compiles whole: a condition without a
          // value its field takes would otherwise be left out of it. "Me"
          // is each reader; for a group's rule, any account stands for one.
          const { engine } = await loadEngine(ctx.db, table.id, () => true);
          checkFilter(
            engine,
            input.rowFilter,
            "rule",
            "userId" in input ? input.userId : user.id,
          );
        }
        await setTableAcl(ctx.db, user.id, input);
        return { ok: true as const };
      }),
    ),
  clearTableAcl: asking({ asks: ["members.manage"] })
    .input(clearTableAclInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const { user } = await guardTable(ctx, input.tableId, "members.manage");
        await clearTableAcl(
          ctx.db,
          user.id,
          input.tableId,
          aclSubjectOf(input),
        );
        return { ok: true as const };
      }),
    ),
  /**
   * A manager's preview of what a collaborator can read: their role, each
   * field's access, their row rule, and a sample page read exactly as they
   * would read it.
   */
  viewAs: asking({ asks: ["members.manage"] })
    .input(viewAsInputSchema)
    .query(({ ctx, input }) =>
      handle(ctx, async () => {
        const { table } = await guardTable(
          ctx,
          input.tableId,
          "members.manage",
        );
        const target = await ctx.db
          .selectFrom("users")
          .select(["id", "displayName", "email"])
          .where("id", "=", input.userId)
          .executeTakeFirst();
        const bindings = await loadBindings(ctx.db, input.userId);
        const role = effectiveTableRole(bindings, table.id, table.baseId);
        // The same answer for an account that is not there and for one the
        // table does not count.
        if (!target || !role) throw new AppError("unknown_account");
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
