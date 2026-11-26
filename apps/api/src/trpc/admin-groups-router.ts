/**
 * Groups, local or kept by the identity provider.
 */
import { givenRoleSchema } from "@anygriddb/core";
import { givenKey, resolveGiven } from "../data/made-roles.js";
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
import { asking, requireInstance, roleNoticeDeps } from "./admin-procedure.js";

/**
 * Local groups and every group's base roles from Administration
 * (ROADMAP #27, ADR 0070). Membership of a SCIM group stays read-only.
 */
export const groupsRouter = t.router({
  list: asking({ asks: ["groups.manage"] }).query(({ ctx }) =>
    handle(ctx, async () => {
      await requireInstance(ctx);
      return { groups: await listGroups(ctx.db) };
    }),
  ),
  get: asking({ asks: ["groups.manage"] })
    .input(z.object({ groupId: z.uuid() }))
    .query(({ ctx, input }) =>
      handle(ctx, async () => {
        await requireInstance(ctx);
        return getGroup(ctx.db, input.groupId);
      }),
    ),
  create: asking({ asks: ["groups.manage"] })
    .input(createLocalGroupInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireInstance(ctx);
        const created = await createLocalGroup(ctx.db, admin.id, input);
        ctx.req.log.info(
          { actor: admin.id, group: created.id },
          "local group created",
        );
        return created;
      }),
    ),
  update: asking({ asks: ["groups.manage"] })
    .input(updateLocalGroupInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireInstance(ctx);
        await updateLocalGroup(ctx.db, admin.id, input);
        ctx.req.log.info(
          { actor: admin.id, group: input.groupId },
          "local group updated",
        );
        return { ok: true as const };
      }),
    ),
  delete: asking({ asks: ["groups.manage"] })
    .input(z.object({ groupId: z.uuid() }))
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireInstance(ctx);
        await deleteLocalGroup(ctx.db, admin.id, input.groupId);
        ctx.req.log.info(
          { actor: admin.id, group: input.groupId },
          "local group deleted",
        );
        return { ok: true as const };
      }),
    ),
  addMember: asking({ asks: ["groups.manage"] })
    .input(localGroupMemberInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireInstance(ctx);
        const { roles } = await addLocalGroupMember(ctx.db, admin.id, input);
        // The member now holds the group's roles: each base's owners
        // learn of it (ROADMAP #91).
        for (const { baseId, role } of roles) {
          await tellOwnersOfRole(await roleNoticeDeps(ctx), {
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
  removeMember: asking({ asks: ["groups.manage"] })
    .input(localGroupMemberInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireInstance(ctx);
        await removeLocalGroupMember(ctx.db, admin.id, input);
        ctx.req.log.info(
          { actor: admin.id, group: input.groupId, target: input.userId },
          "local group member removed",
        );
        return { ok: true as const };
      }),
    ),
  /** Gives any group a role on a live base, or takes it back. */
  setBaseRole: asking({ asks: ["access.grant"] })
    .input(
      z.object({
        groupId: z.uuid(),
        baseId: z.uuid(),
        role: givenRoleSchema.nullable(),
      }),
    )
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireInstance(ctx);
        const role = input.role ? await resolveGiven(ctx.db, input.role) : null;
        const { previous } = await setGroupRole(ctx.db, admin.id, {
          ...input,
          role,
        });
        if (role && input.role !== givenKey(previous)) {
          await tellOwnersOfRole(await roleNoticeDeps(ctx), {
            baseId: input.baseId,
            actorId: admin.id,
            gift: { to: "group", groupId: input.groupId, role },
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
