/**
 * What the instance is connected to: provisioning, mail, single sign-on,
 * and the collector of sign-in events.
 */
import { AppError } from "@anygriddb/core";
import { z } from "zod";
import {
  clearOidc,
  environmentOidc,
  loadOidcRow,
  oidcUpdateSchema,
  proveOidcIssuer,
  publicOidc,
  resolveOidc,
  saveOidc,
} from "../integrations/oidc.js";
import {
  clearSaml,
  environmentSaml,
  loadSamlRow,
  proveSamlCertificate,
  publicSaml,
  resolveSaml,
  samlUpdateSchema,
  saveSaml,
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
  environmentSmtp,
  loadSmtpRow,
  publicSmtp,
  resolveSmtp,
  saveSmtp,
  smtpUpdateSchema,
} from "../integrations/smtp.js";
import {
  clearSyslog,
  publicSyslog,
  saveSyslog,
  sendSyslogTest,
  syslogUpdateSchema,
} from "../integrations/syslog.js";
import { smtpReady } from "../mail.js";
import { isLocalGroup, listGroups } from "../scim/groups.js";
import {
  createScimToken,
  createScimTokenInputSchema,
  listScimTokens,
  revokeScimToken,
  revokeScimTokenInputSchema,
} from "../scim/tokens.js";
import { trailShippingStatus } from "../integrations/trail-shipping.js";
import { handle } from "./guard.js";
import { t } from "./init.js";
import {
  createAdminToken,
  createAdminTokenInputSchema,
  listAdminTokens,
  revokeAdminToken,
  revokeAdminTokenInputSchema,
} from "../auth/admin-tokens.js";
import { asking, requireInstance } from "./admin-procedure.js";

/** Provisioning by an identity provider (SCIM 2.0, ADR 0038). */
export const scimRouter = t.router({
  settings: asking({ asks: ["settings.manage"] }).query(({ ctx }) =>
    handle(ctx, async () => {
      await requireInstance(ctx);
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
  createToken: asking({ asks: ["settings.manage"] })
    .input(createScimTokenInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireInstance(ctx);
        return createScimToken(ctx.db, admin.id, input.name);
      }),
    ),
  revokeToken: asking({ asks: ["settings.manage"] })
    .input(revokeScimTokenInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireInstance(ctx);
        await revokeScimToken(ctx.db, admin.id, input.tokenId);
        return { ok: true as const };
      }),
    ),
});

/**
 * The tokens of the administration API (ADR 0086). Making and revoking
 * one are changes of Administration: each asks for the proof, by the rule
 * every change here has.
 */
export const apiTokensRouter = t.router({
  list: asking({ asks: ["settings.manage"] }).query(({ ctx }) =>
    handle(ctx, async () => {
      await requireInstance(ctx);
      return {
        url: `${ctx.env.PUBLIC_URL}/api/v1/admin`,
        tokens: await listAdminTokens(ctx.db),
      };
    }),
  ),
  /** A new token, shown once. */
  create: asking({ asks: ["settings.manage"] })
    .input(createAdminTokenInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireInstance(ctx);
        const made = await createAdminToken(ctx.db, admin.id, input);
        ctx.req.log.info(
          { actor: admin.id, token: made.id, scopes: input.scopes },
          "administration token made",
        );
        return made;
      }),
    ),
  revoke: asking({ asks: ["settings.manage"] })
    .input(revokeAdminTokenInputSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireInstance(ctx);
        await revokeAdminToken(ctx.db, admin.id, input.tokenId);
        ctx.req.log.info(
          { actor: admin.id, token: input.tokenId },
          "administration token revoked",
        );
        return { ok: true as const };
      }),
    ),
});

export const smtpRouter = t.router({
  get: asking({ asks: ["settings.manage"] }).query(({ ctx }) =>
    handle(ctx, async () => {
      await requireInstance(ctx);
      const [row, resolved] = await Promise.all([
        loadSmtpRow(ctx.db),
        resolveSmtp(ctx.db, ctx.env),
      ]);
      return {
        ...(resolved.source === "env"
          ? environmentSmtp(resolved.config, row)
          : publicSmtp(row)),
        source: resolved.source,
        ready: smtpReady(resolved.config),
      };
    }),
  ),
  update: asking({ asks: ["settings.manage"] })
    .input(smtpUpdateSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireInstance(ctx);
        // What the environment sets is its operator's to change (ADR 0083).
        if ((await resolveSmtp(ctx.db, ctx.env)).source === "env") {
          throw new AppError("set_by_environment");
        }
        return saveSmtp(ctx.db, ctx.env.AUTH_ENCRYPTION_KEY, admin.id, input, {
          ip: ctx.req.ip,
        });
      }),
    ),
  clear: asking({ asks: ["settings.manage"] }).mutation(({ ctx }) =>
    handle(ctx, async () => {
      const admin = await requireInstance(ctx);
      await clearSmtp(ctx.db, admin.id, ctx.req.ip);
      return { ok: true as const };
    }),
  ),
});

export const oidcRouter = t.router({
  get: asking({ asks: ["settings.manage"] }).query(({ ctx }) =>
    handle(ctx, async () => {
      await requireInstance(ctx);
      const [row, resolved] = await Promise.all([
        loadOidcRow(ctx.db),
        resolveOidc(ctx.db, ctx.env),
      ]);
      return {
        ...(resolved.source === "env" && resolved.config
          ? environmentOidc(resolved.config, row)
          : publicOidc(row, ctx.env.PUBLIC_URL)),
        source: resolved.source,
        ready: resolved.config !== null,
      };
    }),
  ),
  update: asking({ asks: ["settings.manage"] })
    .input(oidcUpdateSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireInstance(ctx);
        if ((await resolveOidc(ctx.db, ctx.env)).source === "env") {
          throw new AppError("set_by_environment");
        }
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
  test: asking({ asks: ["settings.manage"] })
    .input(z.object({ issuer: z.url().max(2048) }))
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        await requireInstance(ctx);
        await proveOidcIssuer(input.issuer);
        return { ok: true as const };
      }),
    ),
  clear: asking({ asks: ["settings.manage"] }).mutation(({ ctx }) =>
    handle(ctx, async () => {
      const admin = await requireInstance(ctx);
      await clearOidc(ctx.db, ctx.env, admin.id, ctx.req.ip);
      return { ok: true as const };
    }),
  ),
});

export const samlRouter = t.router({
  get: asking({ asks: ["settings.manage"] }).query(({ ctx }) =>
    handle(ctx, async () => {
      await requireInstance(ctx);
      const [row, resolved] = await Promise.all([
        loadSamlRow(ctx.db),
        resolveSaml(ctx.db, ctx.env),
      ]);
      return {
        ...(resolved.source === "env" && resolved.config
          ? environmentSaml(resolved.config, row)
          : publicSaml(row, ctx.env.PUBLIC_URL)),
        source: resolved.source,
        ready: resolved.config !== null,
      };
    }),
  ),
  update: asking({ asks: ["settings.manage"] })
    .input(samlUpdateSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireInstance(ctx);
        if ((await resolveSaml(ctx.db, ctx.env)).source === "env") {
          throw new AppError("set_by_environment");
        }
        return saveSaml(ctx.db, admin.id, input, ctx.env.PUBLIC_URL, {
          ip: ctx.req.ip,
        });
      }),
    ),
  /** Parses the PEM without saving (ADR 0053). */
  test: asking({ asks: ["settings.manage"] })
    .input(z.object({ idpCert: z.string().trim().min(1).max(16384) }))
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        await requireInstance(ctx);
        proveSamlCertificate(input.idpCert);
        return { ok: true as const };
      }),
    ),
  clear: asking({ asks: ["settings.manage"] }).mutation(({ ctx }) =>
    handle(ctx, async () => {
      const admin = await requireInstance(ctx);
      await clearSaml(ctx.db, ctx.env, admin.id, ctx.req.ip);
      return { ok: true as const };
    }),
  ),
});

/**
 * The syslog collector (ADR 0084): the one the environment names, else
 * the one saved here (ADR 0105). Administration shows where events go,
 * sets it when the environment does not, and sends one to try it.
 */
export const syslogRouter = t.router({
  get: asking({ asks: ["settings.manage"] }).query(({ ctx }) =>
    handle(ctx, async () => {
      await requireInstance(ctx);
      return publicSyslog(ctx.db, ctx.env.SYSLOG);
    }),
  ),
  update: asking({ asks: ["settings.manage"] })
    .input(syslogUpdateSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireInstance(ctx);
        return saveSyslog(ctx.db, ctx.env.SYSLOG, admin.id, input, {
          ip: ctx.req.ip,
        });
      }),
    ),
  clear: asking({ asks: ["settings.manage"] }).mutation(({ ctx }) =>
    handle(ctx, async () => {
      const admin = await requireInstance(ctx);
      await clearSyslog(ctx.db, admin.id, ctx.req.ip);
      return { ok: true as const };
    }),
  ),
  test: asking({ asks: ["settings.manage"] }).mutation(({ ctx }) =>
    handle(ctx, async () => {
      const admin = await requireInstance(ctx);
      await sendSyslogTest(ctx.db, ctx.env.SYSLOG, admin.id);
      return { ok: true as const };
    }),
  ),
});

export const siemRouter = t.router({
  get: asking({ asks: ["settings.manage"] }).query(({ ctx }) =>
    handle(ctx, async () => {
      await requireInstance(ctx);
      return publicSiem(await loadSiemRow(ctx.db));
    }),
  ),
  update: asking({ asks: ["settings.manage"] })
    .input(siemUpdateSchema)
    .mutation(({ ctx, input }) =>
      handle(ctx, async () => {
        const admin = await requireInstance(ctx);
        return saveSiem(ctx.db, ctx.env.AUTH_ENCRYPTION_KEY, admin.id, input, {
          ip: ctx.req.ip,
        });
      }),
    ),
  test: asking({ asks: ["settings.manage"] }).mutation(({ ctx }) =>
    handle(ctx, async () => {
      const admin = await requireInstance(ctx);
      await sendSiemTest(ctx.db, ctx.env.AUTH_ENCRYPTION_KEY, admin.id);
      return { ok: true as const };
    }),
  ),
  clear: asking({ asks: ["settings.manage"] }).mutation(({ ctx }) =>
    handle(ctx, async () => {
      const admin = await requireInstance(ctx);
      await clearSiem(ctx.db, admin.id, ctx.req.ip);
      return { ok: true as const };
    }),
  ),
});

/**
 * The change trail's copy at the collectors (ADR 0120): whether it is
 * on, how far it went, and what waits. Turned on in the instance's
 * settings, with the proof.
 */
export const trailShippingRouter = t.router({
  status: asking({ asks: ["settings.manage"] }).query(({ ctx }) =>
    handle(ctx, async () => {
      await requireInstance(ctx);
      return trailShippingStatus(ctx.db, ctx.env.SYSLOG);
    }),
  ),
});
