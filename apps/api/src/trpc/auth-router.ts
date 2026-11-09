import { z } from "zod";
import {
  AppError,
  createApiTokenInputSchema,
  revokeApiTokenInputSchema,
} from "@anygriddb/core";
import { TRPCError } from "@trpc/server";
import { factorMethods, mfaGate, loadBindings } from "../auth/access.js";
import {
  DUMMY_PASSWORD_HASH,
  hashPassword,
  verifyPassword,
} from "../auth/argon2.js";
import { generateBackupCode, hashBackupCode } from "../auth/backup-code.js";
import {
  consumeBackupCode,
  hasBackupCodes,
  replaceBackupCodes,
} from "../auth/backup-store.js";
import {
  authenticationResponseSchema,
  registrationResponseSchema,
} from "../auth/ceremony.js";
import {
  MFA_ATTEMPT_LIMIT,
  MFA_COOKIE,
  createLoginChallenge,
  deleteLoginChallenge,
  failLoginChallenge,
  findLoginChallenge,
} from "../auth/challenge.js";
import {
  recordAuthEvent,
  type AuthDetail,
  type AuthMethod,
} from "../auth/auth-events.js";
import { alertLock } from "../auth/lock-alerts.js";
import {
  clearFailures,
  countFailure,
  currentLock,
  lockOf,
  type LockedAccount,
} from "../auth/lockout.js";
import { loginInputSchema } from "../auth/login.js";
import {
  SELF_RESET_TTL_MS,
  assertPasswordPolicy,
  changePassword,
  createResetLink,
  findResetLink,
  hasPassword,
  resetPassword,
} from "../auth/password-reset.js";
import {
  sendResetLink,
  sendSecurityNotice,
  type SecurityMailDeps,
} from "../auth/security-mail.js";
import {
  SESSION_COOKIE,
  createSession,
  findSessionUser,
  hashSessionToken,
  isSessionToken,
  revokeSession,
  sessionCookieOptions,
} from "../auth/session.js";
import {
  backupCodeSchema,
  signupInputSchema,
  totpCodeSchema,
  totpConfirmSchema,
} from "../auth/signup.js";
import {
  createApiToken,
  listApiTokens,
  revokeApiToken,
  tokenDays,
} from "../auth/tokens.js";
import { saveTotpSecret, readTotpRow } from "../auth/totp.js";
import { decryptSecret } from "../auth/crypto.js";
import {
  acceptedTotpStep,
  generateTotpSecret,
  totpUri,
} from "../auth/totp-code.js";
import {
  beginAuthentication,
  beginRegistration,
  finishAuthentication,
  finishRegistration,
} from "../auth/webauthn.js";
import { signupDecision } from "../admin.js";
import { smtpReady } from "../mail.js";
import { readGateSettings, readSettings } from "../settings.js";
import { eraseAccount, eraseAccountInputSchema } from "../data/erasure.js";
import { isUniqueViolation } from "../data/schema-ops.js";
import type { Context } from "./context.js";
import { acceptInvitation, invitationPreview } from "../data/sharing.js";
import { extendSessionCookie, procedure, requireUser, t } from "./init.js";
import { mapProcedureError } from "./map-error.js";

function clearCookie(ctx: Context, name: string): void {
  ctx.res.setCookie(name, "", sessionCookieOptions(new Date(0)));
}

/** A refused sign-in: logged, and kept in the sign-in trail (ADR 0042). */
async function signInFailed(
  ctx: Context,
  method: AuthMethod,
  userId: string | null,
  detail: AuthDetail,
): Promise<void> {
  ctx.req.log.warn("authentication failed");
  await recordAuthEvent(ctx.db, {
    action: "login_failure",
    userId,
    method,
    detail,
    ip: ctx.req.ip,
  });
}

function mailDeps(ctx: Context): SecurityMailDeps {
  return { db: ctx.db, env: ctx.env, log: ctx.req.log };
}

/**
 * A wrong password or code for a known account: one more toward its lock
 * (ADR 0043). The lock that this one sets is mailed to the person.
 */
async function failedAttempt(ctx: Context, userId: string): Promise<void> {
  const policy = await readGateSettings(ctx.db);
  if (await countFailure(ctx.db, userId, policy, ctx.req.ip)) {
    const lock = await lockOf(ctx.db, userId, policy);
    const until = lock.locked ? lock.until : null;
    void sendSecurityNotice(mailDeps(ctx), userId, {
      kind: "locked",
      failures: policy.lockoutThreshold,
      until,
    });
    // Administrators hear of it too (ADR 0044), unless turned off.
    await alertLock(
      { db: ctx.db, bus: ctx.bus, env: ctx.env, log: ctx.req.log },
      { userId, failures: policy.lockoutThreshold, until },
    ).catch((error: unknown) => {
      ctx.req.log.error({ err: error }, "lock alert failed");
    });
  }
}

/**
 * A locked account is refused before its password or code is looked at,
 * so a lock tells nothing of whether the guess was right.
 */
async function refuseLocked(
  ctx: Context,
  account: LockedAccount,
  method: AuthMethod,
): Promise<void> {
  const lock = await currentLock(
    ctx.db,
    account,
    await readGateSettings(ctx.db),
  );
  if (lock.locked) {
    await signInFailed(ctx, method, account.id, "account_locked");
    throw new AppError("account_locked");
  }
}

async function issueSession(
  ctx: Context,
  userId: string,
  method: AuthMethod,
): Promise<void> {
  let session: Awaited<ReturnType<typeof createSession>>;
  try {
    session = await createSession(ctx.db, userId);
  } catch (error) {
    if (
      error instanceof AppError &&
      (error.code === "account_disabled" ||
        error.code === "instance_maintenance")
    ) {
      await signInFailed(ctx, method, userId, error.code);
    }
    throw error;
  }
  clearCookie(ctx, MFA_COOKIE);
  ctx.res.setCookie(
    SESSION_COOKIE,
    session.token,
    sessionCookieOptions(session.expiresAt),
  );
  await clearFailures(ctx.db, userId);
  await recordAuthEvent(ctx.db, {
    action: "login_success",
    userId,
    method,
    ip: ctx.req.ip,
  });
}

async function requireChallenge(ctx: Context) {
  const challenge = await findLoginChallenge(
    ctx.db,
    ctx.req.cookies[MFA_COOKIE],
  );
  if (!challenge || challenge.attempts >= MFA_ATTEMPT_LIMIT) {
    if (challenge) {
      await deleteLoginChallenge(ctx.db, challenge.id);
    }
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  const lock = await lockOf(
    ctx.db,
    challenge.userId,
    await readGateSettings(ctx.db),
  );
  if (lock.locked) {
    await deleteLoginChallenge(ctx.db, challenge.id);
    clearCookie(ctx, MFA_COOKIE);
    await signInFailed(ctx, "password", challenge.userId, "account_locked");
    throw new AppError("account_locked");
  }
  return challenge;
}

export const authRouter = t.router({
  /**
   * Public: how sign-up works here, the default language, and what the
   * sign-in page and the app tell everyone (maintenance, the banner).
   */
  instance: procedure.query(async ({ ctx }) => {
    const settings = await readSettings(ctx.db);
    return {
      signup: settings.signup,
      defaultLocale: settings.defaultLocale,
      maintenance: settings.maintenance,
      banner: settings.banner,
      // What the forms need to say (ADR 0043); never the lock's limits.
      passwordMinLength: settings.passwordMinLength,
      selfReset: settings.passwordReset === "self" && smtpReady(ctx.env),
      publicLinks: settings.publicLinks,
      tokenMaxDays: settings.tokenMaxDays,
    };
  }),
  signup: procedure
    .input(signupInputSchema)
    .mutation(async ({ ctx, input }) => {
      const email = input.email.toLowerCase();
      const decision = await signupDecision(
        ctx.db,
        email,
        ctx.env.ADMIN_EMAILS,
      );
      if (!decision.allowed) {
        ctx.req.log.warn("signup refused by policy");
        throw new AppError(decision.refusal ?? "signup_closed");
      }
      assertPasswordPolicy(input.password, await readSettings(ctx.db));
      try {
        const hash = await hashPassword(input.password);
        const userId = await ctx.db.transaction().execute(async (tx) => {
          const inserted = await tx
            .insertInto("users")
            .values({
              email,
              displayName: input.displayName,
              isAdmin: decision.isAdmin,
            })
            .returning("id")
            .executeTakeFirst();
          const id = inserted?.id;
          if (!id) {
            throw new AppError("no_row");
          }
          await tx
            .insertInto("passwordHashes")
            .values({ userId: id, hash })
            .execute();
          return id;
        });
        await issueSession(ctx, userId, "signup");
        return { status: "session" as const };
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new AppError("account_already_exists");
        }
        mapProcedureError(error, ctx.req.log);
      }
    }),
  login: procedure.input(loginInputSchema).mutation(async ({ ctx, input }) => {
    const user = await ctx.db
      .selectFrom("users as u")
      .innerJoin("passwordHashes as p", "p.userId", "u.id")
      .select(["u.id", "p.hash", "u.disabledAt", "u.isAdmin", "u.lockedAt"])
      .where("u.email", "=", input.email.toLowerCase())
      .executeTakeFirst();
    const passwordOk = await verifyPassword(
      user?.hash ?? DUMMY_PASSWORD_HASH,
      input.password,
    );
    if (user) await refuseLocked(ctx, user, "password");
    if (!user || !passwordOk) {
      await signInFailed(
        ctx,
        "password",
        user?.id ?? null,
        "invalid_credentials",
      );
      if (user) await failedAttempt(ctx, user.id);
      throw new AppError("invalid_credentials");
    }
    if (user.disabledAt) {
      await signInFailed(ctx, "password", user.id, "account_disabled");
      throw new AppError("account_disabled");
    }
    await revokeSession(ctx.db, ctx.req.cookies[SESSION_COOKIE]);
    const methods = await factorMethods(ctx.db, user.id);
    if (methods.length > 0) {
      const challenge = await createLoginChallenge(ctx.db, user.id);
      clearCookie(ctx, SESSION_COOKIE);
      ctx.res.setCookie(
        MFA_COOKIE,
        challenge.token,
        sessionCookieOptions(challenge.expiresAt),
      );
      return { status: "mfa" as const, methods };
    }
    await issueSession(ctx, user.id, "password");
    return { status: "session" as const, methods };
  }),
  logout: procedure.mutation(async ({ ctx }) => {
    const ended = await revokeSession(ctx.db, ctx.req.cookies[SESSION_COOKIE]);
    if (ended) {
      await recordAuthEvent(ctx.db, {
        action: "logout",
        userId: ended.userId,
        ip: ctx.req.ip,
      });
    }
    clearCookie(ctx, SESSION_COOKIE);
    clearCookie(ctx, MFA_COOKIE);
    return { ok: true as const };
  }),
  totp: t.router({
    begin: procedure.mutation(async ({ ctx }) => {
      const user = await requireUser(ctx);
      const secret = generateTotpSecret();
      return { secret, otpauthUrl: totpUri(secret, user.displayName) };
    }),
    confirm: procedure
      .input(totpConfirmSchema)
      .mutation(async ({ ctx, input }) => {
        const user = await requireUser(ctx);
        const step = acceptedTotpStep(input.secret, input.code);
        if (step === null) {
          ctx.req.log.warn("authentication failed");
          throw new TRPCError({ code: "UNAUTHORIZED" });
        }
        await saveTotpSecret(
          ctx.db,
          user.id,
          input.secret,
          ctx.env.AUTH_ENCRYPTION_KEY,
          step,
        );
        const backupCodes = Array.from({ length: 8 }, () =>
          generateBackupCode(),
        );
        await replaceBackupCodes(
          ctx.db,
          user.id,
          backupCodes.map((code) => hashBackupCode(code)),
        );
        return { backupCodes };
      }),
    verify: procedure.input(totpCodeSchema).mutation(async ({ ctx, input }) => {
      const challenge = await requireChallenge(ctx);
      const row = await readTotpRow(ctx.db, challenge.userId);
      const secret =
        row?.confirmedAt === null || row?.confirmedAt === undefined
          ? null
          : decryptSecret(
              row.ciphertext,
              row.nonce,
              ctx.env.AUTH_ENCRYPTION_KEY,
            );
      const step =
        secret === null
          ? null
          : acceptedTotpStep(
              secret,
              input.code,
              Date.now(),
              row?.lastStep ?? null,
            );
      // The step is recorded only if newer, in one statement, so a code
      // replayed in parallel cannot open two sessions.
      const recorded =
        step === null || !row
          ? undefined
          : await ctx.db
              .updateTable("totpSecrets")
              .set({ lastStep: step })
              .where("userId", "=", challenge.userId)
              .where((eb) =>
                eb.or([eb("lastStep", "is", null), eb("lastStep", "<", step)]),
              )
              .returning("userId")
              .executeTakeFirst();
      if (!recorded) {
        await failLoginChallenge(ctx.db, challenge.id, challenge.attempts);
        await signInFailed(ctx, "totp", challenge.userId, "mfa_failed");
        await failedAttempt(ctx, challenge.userId);
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }
      await deleteLoginChallenge(ctx.db, challenge.id);
      await issueSession(ctx, challenge.userId, "totp");
      return { status: "session" as const };
    }),
  }),
  backup: t.router({
    verify: procedure
      .input(backupCodeSchema)
      .mutation(async ({ ctx, input }) => {
        const challenge = await requireChallenge(ctx);
        const ok = await consumeBackupCode(
          ctx.db,
          challenge.userId,
          input.code,
        );
        if (!ok) {
          await failLoginChallenge(ctx.db, challenge.id, challenge.attempts);
          await signInFailed(ctx, "backup", challenge.userId, "mfa_failed");
          await failedAttempt(ctx, challenge.userId);
          throw new TRPCError({ code: "UNAUTHORIZED" });
        }
        await deleteLoginChallenge(ctx.db, challenge.id);
        await issueSession(ctx, challenge.userId, "backup");
        return { status: "session" as const };
      }),
  }),
  webauthn: t.router({
    registerBegin: procedure.mutation(async ({ ctx }) => {
      const user = await requireUser(ctx);
      try {
        return await beginRegistration(ctx.db, ctx.env, user);
      } catch (error) {
        mapProcedureError(error, ctx.req.log);
      }
    }),
    registerFinish: procedure
      .input(registrationResponseSchema)
      .mutation(async ({ ctx, input }) => {
        const user = await requireUser(ctx);
        try {
          await finishRegistration(ctx.db, ctx.env, user.id, input);
          if (await hasBackupCodes(ctx.db, user.id)) {
            return { backupCodes: [] as string[] };
          }
          const backupCodes = Array.from({ length: 8 }, () =>
            generateBackupCode(),
          );
          await replaceBackupCodes(
            ctx.db,
            user.id,
            backupCodes.map((code) => hashBackupCode(code)),
          );
          return { backupCodes };
        } catch (error) {
          mapProcedureError(error, ctx.req.log);
        }
      }),
    authenticateBegin: procedure.mutation(async ({ ctx }) => {
      const challenge = await requireChallenge(ctx);
      try {
        return await beginAuthentication(ctx.db, ctx.env, challenge.userId);
      } catch (error) {
        mapProcedureError(error, ctx.req.log);
      }
    }),
    authenticateFinish: procedure
      .input(authenticationResponseSchema)
      .mutation(async ({ ctx, input }) => {
        const challenge = await requireChallenge(ctx);
        try {
          await finishAuthentication(ctx.db, ctx.env, challenge.userId, input);
        } catch (error) {
          await failLoginChallenge(ctx.db, challenge.id, challenge.attempts);
          await signInFailed(ctx, "webauthn", challenge.userId, "mfa_failed");
          await failedAttempt(ctx, challenge.userId);
          mapProcedureError(error, ctx.req.log);
        }
        await deleteLoginChallenge(ctx.db, challenge.id);
        try {
          await issueSession(ctx, challenge.userId, "webauthn");
          return { status: "session" as const };
        } catch (error) {
          mapProcedureError(error, ctx.req.log);
        }
      }),
  }),
  /**
   * The second step under way, for a sign-in that started elsewhere (single
   * sign-on): the factors it may use, or null.
   */
  challenge: procedure.query(async ({ ctx }) => {
    const challenge = await findLoginChallenge(
      ctx.db,
      ctx.req.cookies[MFA_COOKIE],
    );
    if (!challenge || challenge.attempts >= MFA_ATTEMPT_LIMIT) return null;
    return { methods: await factorMethods(ctx.db, challenge.userId) };
  }),
  /** The person changes their own password; their other sessions end. */
  changePassword: procedure
    .input(
      z.object({
        current: z.string().min(1).max(128),
        password: z.string().min(12).max(128),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const user = await requireUser(ctx);
      try {
        // A token acts for its owner, never as them: no password change.
        if (ctx.tokenScope) throw new AppError("access_denied");
        const stored = await ctx.db
          .selectFrom("passwordHashes")
          .select("hash")
          .where("userId", "=", user.id)
          .executeTakeFirst();
        if (!stored) throw new AppError("sso_account");
        if (!(await verifyPassword(stored.hash, input.current))) {
          await failedAttempt(ctx, user.id);
          throw new AppError("invalid_credentials");
        }
        assertPasswordPolicy(input.password, await readSettings(ctx.db));
        const token = ctx.req.cookies[SESSION_COOKIE];
        await changePassword(ctx.db, {
          userId: user.id,
          password: input.password,
          keepSessionHash: isSessionToken(token)
            ? hashSessionToken(token)
            : undefined,
        });
        await recordAuthEvent(ctx.db, {
          action: "password_changed",
          userId: user.id,
          method: "password",
          ip: ctx.req.ip,
        });
        void sendSecurityNotice(mailDeps(ctx), user.id, {
          kind: "password_changed",
        });
        return { ok: true as const };
      } catch (error) {
        mapProcedureError(error, ctx.req.log);
      }
    }),
  /**
   * Public: mails a reset link when the instance lets people ask for one.
   * The answer is the same whether the address has an account or not.
   */
  requestPasswordReset: procedure
    .input(z.object({ email: z.email().max(254) }))
    .mutation(async ({ ctx, input }) => {
      const settings = await readSettings(ctx.db);
      if (settings.passwordReset !== "self" || !smtpReady(ctx.env)) {
        throw new AppError("password_reset_disabled");
      }
      const account = await ctx.db
        .selectFrom("users as u")
        .innerJoin("passwordHashes as p", "p.userId", "u.id")
        .select("u.id")
        .where("u.email", "=", input.email.toLowerCase())
        .where("u.disabledAt", "is", null)
        .executeTakeFirst();
      if (account) {
        const link = await createResetLink(ctx.db, {
          userId: account.id,
          createdBy: null,
          ttlMs: SELF_RESET_TTL_MS,
        });
        await recordAuthEvent(ctx.db, {
          action: "password_reset_requested",
          userId: account.id,
          method: "password",
          detail: "self_service",
          ip: ctx.req.ip,
        });
        // Not awaited: how long the mail takes tells nothing of the account.
        void sendResetLink(mailDeps(ctx), account.id, {
          ...link,
          byAdmin: false,
        }).catch((error: unknown) => {
          ctx.req.log.error({ err: error }, "reset mail failed");
        });
      }
      return { ok: true as const };
    }),
  /** Public: whether a reset link still works, and the length to choose. */
  resetLink: procedure
    .input(z.object({ token: z.string().max(100) }))
    .query(async ({ ctx, input }) => {
      const [link, settings] = await Promise.all([
        findResetLink(ctx.db, input.token),
        readSettings(ctx.db),
      ]);
      return {
        valid: link !== null,
        passwordMinLength: settings.passwordMinLength,
      };
    }),
  /** Public: sets the new password a link allows, once. */
  resetPassword: procedure
    .input(
      z.object({
        token: z.string().max(100),
        password: z.string().min(12).max(128),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const done = await resetPassword(
          ctx.db,
          input.token,
          input.password,
          await readSettings(ctx.db),
        );
        await recordAuthEvent(ctx.db, {
          action: "password_reset",
          userId: done.userId,
          method: "password",
          detail: done.byAdmin ? "admin_reset" : "self_service",
          ip: ctx.req.ip,
        });
        void sendSecurityNotice(mailDeps(ctx), done.userId, {
          kind: "password_changed",
        });
        clearCookie(ctx, SESSION_COOKIE);
        clearCookie(ctx, MFA_COOKIE);
        return { ok: true as const };
      } catch (error) {
        mapProcedureError(error, ctx.req.log);
      }
    }),
  erase: procedure
    .input(eraseAccountInputSchema)
    .mutation(async ({ ctx, input }) => {
      const user = await requireUser(ctx);
      try {
        const stored = await ctx.db
          .selectFrom("passwordHashes")
          .select("hash")
          .where("userId", "=", user.id)
          .executeTakeFirst();
        const verified = await verifyPassword(
          stored?.hash ?? DUMMY_PASSWORD_HASH,
          input.password,
        );
        if (!stored || !verified) {
          throw new AppError("invalid_credentials");
        }
        await eraseAccount(ctx.db, user.id);
        clearCookie(ctx, SESSION_COOKIE);
        clearCookie(ctx, MFA_COOKIE);
        return { ok: true as const };
      } catch (error) {
        mapProcedureError(error, ctx.req.log);
      }
    }),
  tokens: procedure.query(async ({ ctx }) => {
    const user = await requireUser(ctx);
    return { tokens: await listApiTokens(ctx.db, user.id) };
  }),
  createToken: procedure
    .input(createApiTokenInputSchema)
    .mutation(async ({ ctx, input }) => {
      const user = await requireUser(ctx);
      try {
        const policy = await readGateSettings(ctx.db);
        if (policy.apiTokens === "admins" && !user.isAdmin) {
          throw new AppError("api_tokens_restricted");
        }
        return await createApiToken(ctx.db, user.id, input.name, {
          baseIds: input.baseIds,
          readOnly: input.readOnly,
          days: tokenDays(input.days, policy),
        });
      } catch (error) {
        mapProcedureError(error, ctx.req.log);
      }
    }),
  revokeToken: procedure
    .input(revokeApiTokenInputSchema)
    .mutation(async ({ ctx, input }) => {
      const user = await requireUser(ctx);
      try {
        await revokeApiToken(ctx.db, user.id, input.tokenId);
        return { ok: true as const };
      } catch (error) {
        mapProcedureError(error, ctx.req.log);
      }
    }),
  invitation: procedure
    .input(z.object({ token: z.string().max(100) }))
    .query(async ({ ctx, input }) => {
      try {
        return await invitationPreview(ctx.db, input.token);
      } catch (error) {
        mapProcedureError(error, ctx.req.log);
      }
    }),
  acceptInvitation: procedure
    .input(z.object({ token: z.string().max(100) }))
    .mutation(async ({ ctx, input }) => {
      const user = await requireUser(ctx);
      try {
        return await acceptInvitation(ctx.db, user, input.token);
      } catch (error) {
        mapProcedureError(error, ctx.req.log);
      }
    }),
});

export const sessionRouter = t.router({
  providers: procedure.query(({ ctx }) => ({
    oidc: Boolean(
      ctx.env.OIDC_ISSUER &&
      ctx.env.OIDC_CLIENT_ID &&
      ctx.env.OIDC_CLIENT_SECRET &&
      ctx.env.OIDC_REDIRECT_URL,
    ),
    saml: Boolean(
      ctx.env.SAML_ENTRY_POINT &&
      ctx.env.SAML_ISSUER &&
      ctx.env.SAML_CERT &&
      ctx.env.SAML_CALLBACK_URL,
    ),
  })),
  current: procedure.query(async ({ ctx }) => {
    const token = ctx.req.cookies[SESSION_COOKIE];
    const user = await findSessionUser(ctx.db, token);
    if (!user) {
      return null;
    }
    await extendSessionCookie(ctx, token);
    const methods = await factorMethods(ctx.db, user.id);
    const bindings = await loadBindings(ctx.db, user.id);
    const policy = await readGateSettings(ctx.db);
    return {
      ...user,
      mfaEnrolled: methods.length > 0,
      // What the policy asks of this account (ADR 0043): a factor before
      // working at all, and one before creating a base.
      mfaRequired: (await mfaGate(ctx.db, user, bindings)) === "enroll",
      mfaForBases: (await mfaGate(ctx.db, user, [], true)) === "enroll",
      hasPassword: await hasPassword(ctx.db, user.id),
      // What the policy lets this account create (ADR 0044).
      canCreateBases: user.isAdmin || policy.baseCreation === "everyone",
      canCreateTokens: user.isAdmin || policy.apiTokens === "everyone",
    };
  }),
});
