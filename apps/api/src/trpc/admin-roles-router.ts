/**
 * Roles an administrator makes of the permissions of a base (ROADMAP
 * #111, ADR 0128): what each gives, made, changed, and deleted once nobody
 * holds it.
 */
import { madeRoleInputSchema, ROLES, rolePermissions } from "@anygriddb/core";
import { z } from "zod";
import {
  createMadeRole,
  deleteMadeRole,
  listMadeRoles,
  updateMadeRole,
} from "../data/made-roles.js";
import { handle } from "./guard.js";
import { t } from "./init.js";
import { asking, requireInstance } from "./admin-procedure.js";

export const rolesRouter = t.router({
  /** The four, as the packs they are, and every made role. */
  list: asking({ asks: ["roles.manage"] }).query(({ ctx }) =>
    handle(ctx, async () => {
      await requireInstance(ctx);
      return {
        shipped: ROLES.map((role) => ({
          role,
          permissions: rolePermissions(role),
        })),
        made: (await listMadeRoles(ctx.db)).map((role) => ({
          id: role.id,
          name: role.name,
          permissions: [...role.permissions],
          holders: role.holders,
          updatedAt: role.updatedAt.toISOString(),
        })),
      };
    }),
  ),
  create: asking({ asks: ["roles.manage"] })
    .input(madeRoleInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireInstance(ctx);
        const made = await createMadeRole(ctx.db, admin.id, input);
        ctx.req.log.info({ actor: admin.id, role: made.id }, "role made");
        return { id: made.id };
      }),
    ),
  /** What everyone who holds the role may do changes at once. */
  update: asking({ asks: ["roles.manage"] })
    .input(madeRoleInputSchema.extend({ id: z.uuid() }))
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireInstance(ctx);
        await updateMadeRole(ctx.db, admin.id, input);
        ctx.req.log.info({ actor: admin.id, role: input.id }, "role changed");
        return { ok: true as const };
      }),
    ),
  delete: asking({ asks: ["roles.manage"] })
    .input(z.object({ id: z.uuid() }))
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireInstance(ctx);
        await deleteMadeRole(ctx.db, admin.id, input.id);
        ctx.req.log.info({ actor: admin.id, role: input.id }, "role deleted");
        return { ok: true as const };
      }),
    ),
});
