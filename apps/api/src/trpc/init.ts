import "@fastify/cookie";
import { AppError, type MadeNames } from "@anygriddb/core";
import { initTRPC, TRPCError } from "@trpc/server";
import { assertNotInMaintenance } from "../auth/access.js";
import { findApiToken } from "../auth/tokens.js";
import {
  SESSION_COOKIE,
  findSessionUser,
  renewSession,
  sessionCookieOptions,
} from "../auth/session.js";
import type { SessionUser } from "../auth/session.js";
import type { Context } from "./context.js";
import { describeTRPCError, toTRPCError } from "./map-error.js";
import { measureProcedure } from "../observability.js";
import { madeNamesFor } from "../settings.js";

export const t = initTRPC.context<Context>().create({
  errorFormatter({ shape, error }) {
    const reason = describeTRPCError(error);
    return {
      ...shape,
      message:
        reason.code === "internal_error" ? "Internal error" : shape.message,
      data: {
        ...shape.data,
        stack: undefined,
        // What the client translates (ADR 0013); the message is for logs.
        reason: { code: reason.code, detail: reason.detail },
      },
    };
  },
});

/**
 * The base of every procedure: a public error thrown anywhere in a body
 * reaches the client with its status and code, never as an internal one.
 */
export const procedure = t.procedure.use(async ({ ctx, next, path }) => {
  // Timed and traced per procedure, under its HTTP request (ADR 0018).
  const result = await measureProcedure(path, ctx.req, () => next());
  if (
    !result.ok &&
    result.error.code === "INTERNAL_SERVER_ERROR" &&
    result.error.cause instanceof AppError
  ) {
    throw toTRPCError(result.error.cause);
  }
  return result;
});

/**
 * The procedures of one request start together (a page sends its queries
 * as one batch), and each asks who is calling. While that lookup is in
 * flight they share it; once it has answered, the next one asks again, so
 * nothing is read from an answer older than the lookup itself.
 */
const inFlight = new WeakMap<Context, Map<string, Promise<unknown>>>();

export function sharedLookup<T>(
  ctx: Context,
  key: string,
  run: () => Promise<T>,
): Promise<T> {
  const lookups = inFlight.get(ctx) ?? new Map<string, Promise<unknown>>();
  inFlight.set(ctx, lookups);
  const pending = lookups.get(key);
  if (pending) return pending as Promise<T>;
  const lookup = run().finally(() => {
    lookups.delete(key);
  });
  lookups.set(key, lookup);
  return lookup;
}

export function requireUser(ctx: Context): Promise<SessionUser> {
  return sharedLookup(ctx, "user", () => findUser(ctx));
}

async function findUser(ctx: Context): Promise<SessionUser> {
  const bearer = await findApiToken(ctx.db, ctx.req.headers.authorization);
  if (bearer) {
    await assertNotInMaintenance(ctx.db, bearer.user);
    ctx.tokenScope = bearer.scope;
    return bearer.user;
  }
  const token = ctx.req.cookies[SESSION_COOKIE];
  const user = await findSessionUser(ctx.db, token);
  if (!user) {
    ctx.req.log.warn("access denied");
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  await assertNotInMaintenance(ctx.db, user);
  await extendSessionCookie(ctx, token);
  return user;
}

/** Slides the idle timeout and re-sends the cookie with the new expiry. */
export async function extendSessionCookie(
  ctx: Context,
  token: string | undefined,
): Promise<void> {
  const next = await renewSession(ctx.db, token);
  if (next && token) {
    ctx.res.setCookie(SESSION_COOKIE, token, sessionCookieOptions(next));
  }
}

/** The names AnyGridDB makes up for this request, in the app's language. */
export function requestNames(ctx: Context): Promise<MadeNames> {
  return madeNamesFor(ctx.db, ctx.req.headers["accept-language"]);
}
