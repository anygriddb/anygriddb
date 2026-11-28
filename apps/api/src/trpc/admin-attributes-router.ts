/**
 * The attributes an instance knows of a person, and each account's values
 * (ADR 0142). Whoever gives access manages both: a value changes what its
 * holder reaches.
 */
import { attributeKeySchema } from "@anygriddb/core";
import { z } from "zod";
import {
  accountAttributes,
  accountAttributesInputSchema,
  attributeInputSchema,
  createAttribute,
  listAttributes,
  removeAttribute,
  setAccountAttributes,
  updateAttribute,
} from "../data/person-attributes.js";
import { handle } from "./guard.js";
import { t } from "./init.js";
import { asking, requireInstance } from "./admin-procedure.js";

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
  setForAccount: asking({ asks: ["access.grant"] })
    .input(accountAttributesInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireInstance(ctx);
        await setAccountAttributes(ctx.db, admin.id, input);
        ctx.req.log.info(
          { actor: admin.id, target: input.userId },
          "person attributes set",
        );
        return { ok: true as const };
      }),
    ),
});
