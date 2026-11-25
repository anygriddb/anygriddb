import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance } from "fastify";
import { publicErrorBody } from "./http.js";
import { ceilingOf } from "@anygriddb/core";

type RateBucket =
  | "auth"
  | "oauth"
  | "signOn"
  | "share"
  | "api"
  | "upload"
  | "formUpload"
  | "report"
  | "app";

/** Requests allowed per minute and per client address, by bucket. */
export const RATE_LIMITS: Record<RateBucket, number> = {
  auth: ceilingOf("rate.auth"),
  // An application's backend, which renews the grants of all its people
  // from one address. Its secret is long and random, not a password to
  // guess: what this holds back is the work of checking it.
  oauth: ceilingOf("rate.oauth"),
  // The way to an identity provider and back: two requests a sign-in, and
  // the people of an office, behind one address, arrive together.
  signOn: ceilingOf("rate.sign_on"),
  share: ceilingOf("rate.share"),
  api: ceilingOf("rate.api"),
  upload: ceilingOf("rate.upload"),
  // Files sent to public forms, by people who have no account: an answer
  // carries a few, and each is held a day if no answer comes (ADR 0062).
  formUpload: ceilingOf("rate.form_upload"),
  // Failures pages report: a page that fails in a loop stops here.
  report: ceilingOf("rate.report"),
  app: ceilingOf("rate.app"),
};

/**
 * The calls anyone can send without a session, or with a sign-in half
 * made, that check a password, a code or a secret link, or that mail one:
 * the tight limit per address is for them.
 */
const SIGN_IN_CALL =
  /^(auth\.(login|signup|totp\.verify|backup\.verify|email\.(send|verify)|webauthn\.authenticate\w*|invitation|acceptInvitation|erase|changePassword|requestPasswordReset|resetLink|resetPassword|confirmSignup)|rows\.sign)$/;

/**
 * The proofs a signed-in person gives before a factor changes or before
 * Administration: guesses too, held by the account's lock rather than by
 * the address, since each needs the session.
 */
const PROOF_CALL =
  /^(auth\.(totp\.confirm|email\.(begin|disable)|webauthn\.(registerBegin|remove))|admin\.stepUp)$/;

/**
 * Whether a call checks a password, a code or a secret link. A request
 * names at most one such call, and those about one account take turns
 * (`auth/guess-turns`).
 */
export function checksCredential(procedure: string): boolean {
  return SIGN_IN_CALL.test(procedure) || PROOF_CALL.test(procedure);
}

/** The procedures a tRPC address names: a batch separates them by commas. */
function trpcCalls(url: string): string[] {
  const path = url.split("?")[0] ?? url;
  if (!path.startsWith("/trpc/")) return [];
  return decodeURIComponent(path.slice("/trpc/".length)).split(",");
}

/** More than a public page ever asks for at once. */
const MAX_SHARE_CALLS = 10;

/** Whether a request names more public-link calls than any page sends. */
export function tooManyShareCalls(url: string): boolean {
  return (
    trpcCalls(url).filter((call) => call.startsWith("share.")).length >
    MAX_SHARE_CALLS
  );
}

/** How many of a request's calls check a credential. */
export function credentialCalls(url: string): number {
  return trpcCalls(url).filter(checksCredential).length;
}

export function rateBucket(method: string, url: string): RateBucket {
  const path = url.split("?")[0] ?? url;
  if (path.startsWith("/trpc/")) {
    const calls = trpcCalls(url);
    if (calls.some((call) => SIGN_IN_CALL.test(call))) return "auth";
    // A sign-up's link is a token a page opens, as a public share is.
    if (
      calls.some(
        (call) => call.startsWith("share.") || call === "auth.signupLink",
      )
    ) {
      return "share";
    }
    return "app";
  }
  // No password is checked there: the provider does it.
  if (path.startsWith("/auth/")) return "signOn";
  // An application's secret is checked at these two (ADR 0094).
  if (path === "/oauth/token" || path === "/oauth/revoke") return "oauth";
  // Public addresses a token opens, as public shares are.
  if (path.startsWith("/hooks/") || path.startsWith("/ical/")) return "share";
  if (
    path.startsWith("/api/v1/") ||
    path.startsWith("/scim/") ||
    path === "/mcp"
  )
    return "api";
  if (path.startsWith("/api/shares/") && method === "POST") return "formUpload";
  if (
    (path.startsWith("/api/attachments") ||
      path.startsWith("/api/import/") ||
      path === "/api/snapshot/upload") &&
    method === "POST"
  )
    return "upload";
  if (path === "/api/client-errors") return "report";
  return "app";
}

/**
 * Whether a request reads a file of the app's build (`/assets`, each under
 * a name that changes with its content). They are not counted: a first
 * page asks for a hundred of them, so the people behind one address,
 * opening the app after an upgrade gave every file a new name, used up
 * what their pages may then ask of the server, and were refused the
 * scripts themselves. Sent from the disk as they are, they ask nothing a
 * limit protects.
 */
export function buildFile(method: string, url: string): boolean {
  return (
    (method === "GET" || method === "HEAD") &&
    (url.split("?")[0] ?? url).startsWith("/assets/")
  );
}

/** The probes that say whether the process runs and the database answers. */
const PROBES = new Set(["/health", "/healthz", "/ready", "/readyz"]);

/**
 * Whether a request asks whether the instance runs. Not counted: counting
 * asks the database, and `/health` must answer while it does not, or the
 * container is restarted for the database's fault.
 */
export function probe(url: string): boolean {
  return PROBES.has(url.split("?")[0] ?? url);
}

/** One window of counting: a minute. */
const RATE_WINDOW_MS = 60_000;

/**
 * Counts each address's requests by kind, a minute at a time. Given a
 * store, in it: the instance's is PostgreSQL (ADR 0132), so every process
 * counts the same requests and a limit holds however many serve; and the
 * windows that ended are removed each minute. A test's server counts in
 * its own memory.
 */
export async function registerRateLimit(
  app: FastifyInstance,
  shared?: {
    store: NonNullable<Parameters<typeof rateLimit>[1]>["store"];
    prune: (timeWindow: number) => Promise<void>;
  },
): Promise<void> {
  if (shared) {
    let pruning: ReturnType<typeof setInterval> | undefined;
    app.addHook("onReady", (done) => {
      pruning = setInterval(() => {
        shared.prune(RATE_WINDOW_MS).catch((error: unknown) => {
          app.log.warn({ err: error }, "rate windows not pruned");
        });
      }, RATE_WINDOW_MS);
      pruning.unref();
      done();
    });
    app.addHook("onClose", (_instance, done) => {
      clearInterval(pruning);
      done();
    });
  }
  await app.register(rateLimit, {
    ...(shared ? { store: shared.store } : {}),
    timeWindow: RATE_WINDOW_MS,
    allowList: (request) =>
      buildFile(request.method, request.url) || probe(request.url),
    // A count the database could not take lets the request through: what
    // it asks then meets the same database, and is refused there if need
    // be (the store says it once a minute, `rate-store.ts`).
    skipOnError: true,
    keyGenerator: (request) =>
      `${request.ip}:${rateBucket(request.method, request.url)}`,
    max: (request) => RATE_LIMITS[rateBucket(request.method, request.url)],
    errorResponseBuilder: (_request, context) => ({
      statusCode: 429,
      error: "Too many requests",
      retryAfter: Math.ceil(context.ttl / 1000),
    }),
  });
  // One guess a request: a batch naming several credential checks would
  // count once above and try them all.
  app.addHook("onRequest", async (request, reply) => {
    if (credentialCalls(request.url) > 1 || tooManyShareCalls(request.url)) {
      return reply.code(400).send(publicErrorBody(400));
    }
  });
}
