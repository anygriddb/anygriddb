/**
 * Groups, local or kept by the identity provider.
 */
import { ROLES } from "@anygriddb/core";
import { z } from "zod";
import {
  addLocalGroupMember,
  createLocalGroup,
  createLocalGroupInputSchema,
  deleteLocalGroup,
  getGroup,
  listGroups,
  localGroupMemberInputSchema,
  removeLocalGroupMember,
  setGroupRole,
  updateLocalGroup,
  updateLocalGroupInputSchema,
} from "../scim/groups.js";
import { handle } from "./guard.js";
import { tellOwnersOfRole } from "../data/role-notices.js";
import { t } from "./init.js";
import { procedure, requireAdmin, roleNoticeDeps } from "./admin-procedure.js";

/**
 * Local groups and every group's base roles from Administration
 * (ROADMAP #27, ADR 0070). Membership of a SCIM group stays read-only.
 */
export const groupsRouter = t.router({
  list: procedure.query(({ ctx }) =>
    handle(ctx, async () => {
      await requireAdmin(ctx);
      return { groups: await listGroups(ctx.db) };
    }),
  ),
  get: procedure
    .input(z.object({ groupId: z.uuid() }))
    .query(({ ctx, input }) =>
      handle(ctx, async () => {
        await requireAdmin(ctx);
        return getGroup(ctx.db, input.groupId);
      }),
    ),
  create: procedure
    .input(createLocalGroupInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireAdmin(ctx);
        const created = await createLocalGroup(ctx.db, admin.id, input);
        ctx.req.log.info(
          { actor: admin.id, group: created.id },
          "local group created",
        );
        return created;
      }),
    ),
  update: procedure
    .input(updateLocalGroupInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireAdmin(ctx);
        await updateLocalGroup(ctx.db, admin.id, input);
        ctx.req.log.info(
          { actor: admin.id, group: input.groupId },
          "local group updated",
        );
        return { ok: true as const };
      }),
    ),
  delete: procedure
    .input(z.object({ groupId: z.uuid() }))
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireAdmin(ctx);
        await deleteLocalGroup(ctx.db, admin.id, input.groupId);
        ctx.req.log.info(
          { actor: admin.id, group: input.groupId },
          "local group deleted",
        );
        return { ok: true as const };
      }),
    ),
  addMember: procedure
    .input(localGroupMemberInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireAdmin(ctx);
        const { roles } = await addLocalGroupMember(ctx.db, admin.id, input);
        // The member now holds the group's roles: each base's owners
        // learn of it (ROADMAP #91).
        for (const { baseId, role } of roles) {
          await tellOwnersOfRole(roleNoticeDeps(ctx), {
            baseId,
            actorId: admin.id,
            gift: { to: "member", ...input, role },
          });
        }
        ctx.req.log.info(
          { actor: admin.id, group: input.groupId, target: input.userId },
          "local group member added",
        );
        return { ok: true as const };
      }),
    ),
  removeMember: procedure
    .input(localGroupMemberInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireAdmin(ctx);
        await removeLocalGroupMember(ctx.db, admin.id, input);
        ctx.hub.closeUser(input.userId, 4000);
        ctx.req.log.info(
          { actor: admin.id, group: input.groupId, target: input.userId },
          "local group member removed",
        );
        return { ok: true as const };
      }),
    ),
  /** Gives any group a role on a live base, or takes it back. */
  setBaseRole: procedure
    .input(
      z.object({
        groupId: z.uuid(),
        baseId: z.uuid(),
        role: z.enum(ROLES).nullable(),
      }),
    )
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireAdmin(ctx);
        const { previous } = await setGroupRole(ctx.db, admin.id, input);
        if (input.role && input.role !== previous) {
          await tellOwnersOfRole(roleNoticeDeps(ctx), {
            baseId: input.baseId,
            actorId: admin.id,
            gift: { to: "group", groupId: input.groupId, role: input.role },
          });
        }
        ctx.req.log.info(
          {
            actor: admin.id,
            group: input.groupId,
            base: input.baseId,
            role: input.role,
          },
          "group base role set by administrator",
        );
        return { ok: true as const };
      }),
    ),
});
