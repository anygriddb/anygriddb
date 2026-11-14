import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance } from "fastify";

type RateBucket =
  "auth" | "share" | "api" | "upload" | "formUpload" | "report" | "app";

/** Requests allowed per minute and per client address, by bucket. */
export const RATE_LIMITS: Record<RateBucket, number> = {
  auth: 20,
  share: 240,
  api: 600,
  upload: 120,
  // Files sent to public forms, by people who have no account: an answer
  // carries a few, and each is held a day if no answer comes (ADR 0062).
  formUpload: 30,
  // Failures pages report: a page that fails in a loop stops here.
  report: 30,
  app: 3_000,
};

const AUTH_PROCEDURES =
  /(^|[,/])(auth\.(login|signup|totp\.verify|backup\.verify|webauthn\.authenticate\w*|invitation|acceptInvitation|erase|changePassword|requestPasswordReset|resetLink|resetPassword|confirmSignup)|rows\.sign)(?=[,?]|$)/;

export function rateBucket(method: string, url: string): RateBucket {
  const path = url.split("?")[0] ?? url;
  if (path.startsWith("/trpc/")) {
    const procedures = decodeURIComponent(path.slice("/trpc/".length));
    if (AUTH_PROCEDURES.test(procedures)) return "auth";
    // A sign-up's link is a token a page opens, as a public share is.
    if (/(^|,)(share\.|auth\.signupLink(?=[,?]|$))/.test(procedures)) {
      return "share";
    }
    return "app";
  }
  if (path.startsWith("/auth/")) return "auth";
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
    (path.startsWith("/api/attachments") || path.startsWith("/api/import/")) &&
    method === "POST"
  )
    return "upload";
  if (path === "/api/client-errors") return "report";
  return "app";
}

/**
 * Counts in memory, per process (ADR 0009): with several API processes the
 * limits add up, which suits the instances AnyGridDB targets.
 */
export async function registerRateLimit(app: FastifyInstance): Promise<void> {
  await app.register(rateLimit, {
    timeWindow: 60_000,
    keyGenerator: (request) =>
      `${request.ip}:${rateBucket(request.method, request.url)}`,
    max: (request) => RATE_LIMITS[rateBucket(request.method, request.url)],
    errorResponseBuilder: (_request, context) => ({
      statusCode: 429,
      error: "Too many requests",
      retryAfter: Math.ceil(context.ttl / 1000),
    }),
  });
}
