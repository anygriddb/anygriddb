/**
 * What the instance is connected to: provisioning, mail, single sign-on,
 * and the collector of sign-in events.
 */
import { z } from "zod";
import {
  clearOidc,
  loadOidcRow,
  proveOidcIssuer,
  publicOidc,
  resolveOidc,
  saveOidc,
  oidcUpdateSchema,
} from "../integrations/oidc.js";
import {
  clearSaml,
  loadSamlRow,
  proveSamlCertificate,
  publicSaml,
  resolveSaml,
  saveSaml,
  samlUpdateSchema,
} from "../integrations/saml.js";
import {
  clearSiem,
  loadSiemRow,
  publicSiem,
  saveSiem,
  sendSiemTest,
  siemUpdateSchema,
} from "../integrations/siem.js";
import {
  clearSmtp,
  loadSmtpRow,
  publicSmtp,
  resolveSmtp,
  saveSmtp,
  smtpUpdateSchema,
} from "../integrations/smtp.js";
import { smtpReady } from "../mail.js";
import { isLocalGroup, listGroups } from "../scim/groups.js";
import {
  createScimToken,
  createScimTokenInputSchema,
  listScimTokens,
  revokeScimToken,
  revokeScimTokenInputSchema,
} from "../scim/tokens.js";
import { handle } from "./guard.js";
import { t } from "./init.js";
import { procedure, requireAdmin } from "./admin-procedure.js";

/** Provisioning by an identity provider (SCIM 2.0, ADR 0038). */
export const scimRouter = t.router({
  settings: procedure.query(({ ctx }) =>
    handle(ctx, async () => {
      await requireAdmin(ctx);
      const groups = (await listGroups(ctx.db)).filter(
        (group) => !isLocalGroup(group.provider),
      );
      return {
        url: `${ctx.env.PUBLIC_URL}/scim/v2`,
        tokens: await listScimTokens(ctx.db),
        groups,
      };
    }),
  ),
  /** A new token, shown once. */
  createToken: procedure
    .input(createScimTokenInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireAdmin(ctx);
        return createScimToken(ctx.db, admin.id, input.name);
      }),
    ),
  revokeToken: procedure
    .input(revokeScimTokenInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireAdmin(ctx);
        await revokeScimToken(ctx.db, admin.id, input.tokenId);
        return { ok: true as const };
      }),
    ),
});

export const smtpRouter = t.router({
  get: procedure.query(({ ctx }) =>
    handle(ctx, async () => {
      await requireAdmin(ctx);
      const [row, resolved] = await Promise.all([
        loadSmtpRow(ctx.db),
        resolveSmtp(ctx.db, ctx.env),
      ]);
      return {
        ...publicSmtp(row),
        source: resolved.source,
        ready: smtpReady(resolved.config),
      };
    }),
  ),
  update: procedure.input(smtpUpdateSchema).mutation(({ ctx, input }) =>
    handle(ctx, async () => {
      const admin = await requireAdmin(ctx);
      return saveSmtp(ctx.db, ctx.env.AUTH_ENCRYPTION_KEY, admin.id, input, {
        ip: ctx.req.ip,
      });
    }),
  ),
  clear: procedure.mutation(({ ctx }) =>
    handle(ctx, async () => {
      const admin = await requireAdmin(ctx);
      await clearSmtp(ctx.db, admin.id, ctx.req.ip);
      return { ok: true as const };
    }),
  ),
});

export const oidcRouter = t.router({
  get: procedure.query(({ ctx }) =>
    handle(ctx, async () => {
      await requireAdmin(ctx);
      const [row, resolved] = await Promise.all([
        loadOidcRow(ctx.db),
        resolveOidc(ctx.db, ctx.env),
      ]);
      return {
        ...publicOidc(row, ctx.env.PUBLIC_URL),
        source: resolved.source,
        ready: resolved.config !== null,
      };
    }),
  ),
  update: procedure.input(oidcUpdateSchema).mutation(({ ctx, input }) =>
    handle(ctx, async () => {
      const admin = await requireAdmin(ctx);
      return saveOidc(
        ctx.db,
        ctx.env.AUTH_ENCRYPTION_KEY,
        admin.id,
        input,
        ctx.env.PUBLIC_URL,
        { ip: ctx.req.ip },
      );
    }),
  ),
  /** Proves discovery without saving (ADR 0053). */
  test: procedure
    .input(z.object({ issuer: z.url().max(2048) }))
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        await requireAdmin(ctx);
        await proveOidcIssuer(input.issuer);
        return { ok: true as const };
      }),
    ),
  clear: procedure.mutation(({ ctx }) =>
    handle(ctx, async () => {
      const admin = await requireAdmin(ctx);
      await clearOidc(ctx.db, admin.id, ctx.req.ip);
      return { ok: true as const };
    }),
  ),
});

export const samlRouter = t.router({
  get: procedure.query(({ ctx }) =>
    handle(ctx, async () => {
      await requireAdmin(ctx);
      const [row, resolved] = await Promise.all([
        loadSamlRow(ctx.db),
        resolveSaml(ctx.db, ctx.env),
      ]);
      return {
        ...publicSaml(row, ctx.env.PUBLIC_URL),
        source: resolved.source,
        ready: resolved.config !== null,
      };
    }),
  ),
  update: procedure.input(samlUpdateSchema).mutation(({ ctx, input }) =>
    handle(ctx, async () => {
      const admin = await requireAdmin(ctx);
      return saveSaml(ctx.db, admin.id, input, ctx.env.PUBLIC_URL, {
        ip: ctx.req.ip,
      });
    }),
  ),
  /** Parses the PEM without saving (ADR 0053). */
  test: procedure
    .input(z.object({ idpCert: z.string().trim().min(1).max(16384) }))
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        await requireAdmin(ctx);
        proveSamlCertificate(input.idpCert);
        return { ok: true as const };
      }),
    ),
  clear: procedure.mutation(({ ctx }) =>
    handle(ctx, async () => {
      const admin = await requireAdmin(ctx);
      await clearSaml(ctx.db, admin.id, ctx.req.ip);
      return { ok: true as const };
    }),
  ),
});

export const siemRouter = t.router({
  get: procedure.query(({ ctx }) =>
    handle(ctx, async () => {
      await requireAdmin(ctx);
      return publicSiem(await loadSiemRow(ctx.db));
    }),
  ),
  update: procedure.input(siemUpdateSchema).mutation(({ ctx, input }) =>
    handle(ctx, async () => {
      const admin = await requireAdmin(ctx);
      return saveSiem(ctx.db, ctx.env.AUTH_ENCRYPTION_KEY, admin.id, input, {
        ip: ctx.req.ip,
      });
    }),
  ),
  test: procedure.mutation(({ ctx }) =>
    handle(ctx, async () => {
      const admin = await requireAdmin(ctx);
      await sendSiemTest(ctx.db, ctx.env.AUTH_ENCRYPTION_KEY, admin.id);
      return { ok: true as const };
    }),
  ),
  clear: procedure.mutation(({ ctx }) =>
    handle(ctx, async () => {
      const admin = await requireAdmin(ctx);
      await clearSiem(ctx.db, admin.id, ctx.req.ip);
      return { ok: true as const };
    }),
  ),
});
