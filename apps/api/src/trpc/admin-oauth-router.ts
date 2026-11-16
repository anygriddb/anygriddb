/**
 * OAuth clients in Administration (ADR 0094): register, list, revoke.
 */
import { z } from "zod";
import {
  listOauthClients,
  registerOauthClient,
  revokeOauthClient,
} from "../oauth/clients.js";
import { handle } from "./guard.js";
import { procedure, requireAdmin } from "./admin-procedure.js";
import { t } from "./init.js";

const redirectUri = z
  .string()
  .trim()
  .min(1)
  .max(2_000)
  .refine(
    (uri) =>
      /^https:\/\//i.test(uri) ||
      /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/.*)?$/i.test(uri),
    { message: "redirect" },
  );

export const oauthClientsRouter = t.router({
  list: procedure.query(({ ctx }) =>
    handle(ctx, async () => {
      await requireAdmin(ctx);
      return listOauthClients(ctx.db);
    }),
  ),
  create: procedure
    .input(
      z
        .object({
          name: z.string().trim().min(1).max(100),
          redirectUris: z.array(redirectUri).min(1).max(20),
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireAdmin(ctx);
        return registerOauthClient(ctx.db, admin.id, input);
      }),
    ),
  revoke: procedure
    .input(z.object({ clientId: z.uuid() }).strict())
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireAdmin(ctx);
        await revokeOauthClient(ctx.db, admin.id, input.clientId);
        return { ok: true as const };
      }),
    ),
});
