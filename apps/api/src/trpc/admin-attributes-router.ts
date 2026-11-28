/**
 * The attributes an instance knows of a person, and each account's values
 * (ADR 0142). Whoever gives access manages both: a value changes what its
 * holder reaches.
 */
import { AppError, attributeKeySchema } from "@anygriddb/core";
import { z } from "zod";
import {
  accountAttributes,
  accountAttributesInputSchema,
  attributeInputSchema,
  basesRuledBy,
  createAttribute,
  listAttributes,
  removeAttribute,
  setAccountAttributes,
  updateAttribute,
} from "../data/person-attributes.js";
import { tellOwnersOfRole } from "../data/role-notices.js";
import { handle } from "./guard.js";
import { t } from "./init.js";
import { asking, requireInstance, roleNoticeDeps } from "./admin-procedure.js";

export const attributesRouter = t.router({
  list: asking({ asks: ["access.grant"] }).query(({ ctx }) =>
    handle(ctx, async () => {
      await requireInstance(ctx);
      return { attributes: await listAttributes(ctx.db) };
    }),
  ),
  create: asking({ asks: ["access.grant"] })
    .input(attributeInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireInstance(ctx);
        await createAttribute(ctx.db, admin.id, input);
        ctx.req.log.info(
          { actor: admin.id, attribute: input.key },
          "person attribute created",
        );
        return { ok: true as const };
      }),
    ),
  update: asking({ asks: ["access.grant"] })
    .input(attributeInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireInstance(ctx);
        await updateAttribute(ctx.db, admin.id, input);
        return { ok: true as const };
      }),
    ),
  remove: asking({ asks: ["access.grant"] })
    .input(z.object({ key: attributeKeySchema }).strict())
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireInstance(ctx);
        await removeAttribute(ctx.db, admin.id, input.key);
        ctx.req.log.info(
          { actor: admin.id, attribute: input.key },
          "person attribute removed",
        );
        return { ok: true as const };
      }),
    ),
  /** One account's values, by attribute. */
  ofAccount: asking({ asks: ["access.grant"] })
    .input(z.object({ userId: z.uuid() }).strict())
    .query(({ ctx, input }) =>
      handle(ctx, async () => {
        await requireInstance(ctx);
        return { values: await accountAttributes(ctx.db, input.userId) };
      }),
    ),
  /**
   * Sets an account's values. They change what it reaches where a rule
   * names them, as a role does (ADR 0143): the owners of those bases are
   * told, and an administrator's own values ask a reason, as a role they
   * give themselves does (ADR 0074).
   */
  setForAccount: asking({ asks: ["access.grant"] })
    .input(accountAttributesInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireInstance(ctx);
        const own = input.userId === admin.id;
        if (own && !input.reason) throw new AppError("reason_required");
        const changed = await setAccountAttributes(ctx.db, admin.id, {
          ...input,
          reason: own ? input.reason : undefined,
        });
        const bases = await basesRuledBy(
          ctx.db,
          input.userId,
          changed.map(({ key }) => key),
        );
        const attributes = changed.map(({ label }) => label).join(", ");
        if (bases.length > 0) {
          const deps = await roleNoticeDeps(ctx);
          const gift = {
            to: "values" as const,
            userId: input.userId,
            attributes,
            ...(own && input.reason ? { reason: input.reason } : {}),
          };
          for (const baseId of bases) {
            await tellOwnersOfRole(deps, { baseId, actorId: admin.id, gift });
          }
        }
        ctx.req.log.info(
          { actor: admin.id, target: input.userId, bases: bases.length },
          "person attributes set",
        );
        return { ok: true as const };
      }),
    ),
});
