/**
 * OAuth 2.1 token and revoke endpoints (ADR 0094). Authorization consent
 * lives in the app (session + tRPC); these accept form bodies from the
 * client application.
 */
import type { Database } from "@anygriddb/db";
import { AppError } from "@anygriddb/core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  exchangeAuthorizationCode,
  refreshAccessToken,
  revokeRefreshToken,
  type TokenResponse,
} from "./flow.js";

type Form = Record<string, string>;

function formOf(body: unknown): Form {
  if (!body || typeof body !== "object" || Array.isArray(body)) return {};
  const out: Form = {};
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

function oauthError(
  reply: FastifyReply,
  status: number,
  error: string,
  description?: string,
) {
  return reply
    .code(status)
    .header("cache-control", "no-store")
    .send({
      error,
      ...(description ? { error_description: description } : {}),
    });
}

function tokenOk(reply: FastifyReply, body: TokenResponse) {
  return reply.code(200).header("cache-control", "no-store").send(body);
}

export function registerOauth(
  app: FastifyInstance,
  deps: { db: Database },
): void {
  /**
   * Starts the browser grant: sends the person to the consent page with
   * the same query string. The SPA requires a session.
   */
  app.get("/oauth/authorize", async (request, reply) => {
    const query = request.url.includes("?")
      ? request.url.slice(request.url.indexOf("?"))
      : "";
    return reply.redirect(`/oauth/consent${query}`);
  });

  app.post(
    "/oauth/token",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const form = formOf(request.body);
      try {
        if (form.grant_type === "authorization_code") {
          return tokenOk(
            reply,
            await exchangeAuthorizationCode(deps.db, {
              clientId: form.client_id ?? "",
              clientSecret: form.client_secret ?? "",
              code: form.code ?? "",
              redirectUri: form.redirect_uri ?? "",
              codeVerifier: form.code_verifier ?? "",
            }),
          );
        }
        if (form.grant_type === "refresh_token") {
          return tokenOk(
            reply,
            await refreshAccessToken(deps.db, {
              clientId: form.client_id ?? "",
              clientSecret: form.client_secret ?? "",
              refreshToken: form.refresh_token ?? "",
            }),
          );
        }
        return oauthError(reply, 400, "unsupported_grant_type");
      } catch (error) {
        if (error instanceof AppError && error.code === "invalid_input") {
          return oauthError(reply, 400, "invalid_grant");
        }
        throw error;
      }
    },
  );

  app.post(
    "/oauth/revoke",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const form = formOf(request.body);
      try {
        await revokeRefreshToken(deps.db, {
          clientId: form.client_id ?? "",
          clientSecret: form.client_secret ?? "",
          refreshToken: form.token ?? form.refresh_token ?? "",
        });
      } catch (error) {
        if (!(error instanceof AppError && error.code === "invalid_input")) {
          throw error;
        }
      }
      // RFC 7009: always 200, even when the token was already gone.
      return reply.code(200).header("cache-control", "no-store").send({});
    },
  );
}
