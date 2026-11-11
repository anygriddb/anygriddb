/**
 * Calls the real tRPC router as browsers would, for integration tests on a
 * migrated database: each browser keeps its own cookie jar, behind one
 * client address.
 */
import { AppError } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import type { FastifyReply, FastifyRequest } from "fastify";
import { vi } from "vitest";
import { hashPassword } from "../auth/argon2.js";
import { decodeBase32, totpCode } from "../auth/totp-code.js";
import type { Env } from "../env.js";
import type { FileStore } from "../files/index.js";
import { recordingBus } from "../realtime/recording-bus.test-helpers.js";
import type { Context } from "./context.js";
import { appRouter } from "./router.js";

export const TEST_IP = "203.0.113.7";

export function browserFactory(deps: {
  db: () => Database;
  env: Env;
  hub: Context["hub"];
  ip?: string;
}) {
  return function browser() {
    const jar: Record<string, string> = {};
    const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
    const call = (headers: Record<string, string> = {}) => {
      const req = {
        cookies: jar,
        headers,
        ip: deps.ip ?? TEST_IP,
        log,
      } as unknown as FastifyRequest;
      const res = {
        // A cleared cookie is an empty one, as the browser would send none.
        setCookie: (name: string, value: string) => {
          jar[name] = value;
        },
      } as unknown as FastifyReply;
      const ctx: Context = {
        db: deps.db(),
        bus: recordingBus().bus,
        req,
        res,
        env: deps.env,
        files: { driver: "disk" } as unknown as FileStore,
        hub: deps.hub,
        sources: {
          allows: () => false,
          allowedHosts: [],
          allowPlaintext: false,
        },
        tls: () => null,
      };
      return appRouter.createCaller(ctx);
    };
    return { jar, call, log };
  };
}

export type TestBrowser = ReturnType<ReturnType<typeof browserFactory>>;

/** "ok", or the code a call failed with: an AppError's, or tRPC's. */
/**
 * An account whose address is proved, signed in in this browser: what a
 * sign-up and the link it mails make (ADR 0058), without the mail. For
 * tests whose subject is not the sign-up itself; `auth.signup` makes the
 * first account of an instance at once.
 */
export async function signUpProved(
  page: TestBrowser,
  db: Database,
  input: { email: string; displayName: string; password: string },
): Promise<string> {
  const hash = await hashPassword(input.password);
  const id = await db.transaction().execute(async (tx) => {
    const user = await tx
      .insertInto("users")
      .values({
        email: input.email.toLowerCase(),
        displayName: input.displayName,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await tx
      .insertInto("passwordHashes")
      .values({ userId: user.id, hash })
      .execute();
    return user.id;
  });
  await page
    .call()
    .auth.login({ email: input.email, password: input.password });
  return id;
}

export async function errorCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "ok";
  } catch (error) {
    if (error instanceof AppError) return error.code;
    const cause = (error as { cause?: unknown }).cause;
    if (cause instanceof AppError) return cause.code;
    const reason = (error as { code?: string }).code;
    return reason ?? "unknown";
  }
}

/**
 * Turns on TOTP for the signed-in account and returns its secret. A code
 * for the next sign-in must be of a later step: see `nextTotp`.
 */
export async function enrollTotp(browser: TestBrowser): Promise<string> {
  const begun = await browser.call().auth.totp.begin();
  await browser.call().auth.totp.confirm({
    secret: begun.secret,
    code: totpCode(decodeBase32(begun.secret), Date.now()),
  });
  return begun.secret;
}

/** A code of the next step, which a sign-in after enrolling accepts. */
export function nextTotp(secret: string): string {
  return totpCode(decodeBase32(secret), Date.now() + 30_000);
}
