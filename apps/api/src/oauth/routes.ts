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

const FORM_KEYS = [
  "grant_type",
  "client_id",
  "client_secret",
  "code",
  "redirect_uri",
  "code_verifier",
  "refresh_token",
  "token",
] as const;

type FormKey = (typeof FORM_KEYS)[number];
type Form = Partial<Record<FormKey, string>>;

function formOf(body: unknown): Form {
  if (!body || typeof body !== "object" || Array.isArray(body)) return {};
  const raw = body as Record<string, unknown>;
  const out: Form = {};
  for (const key of FORM_KEYS) {
    const value = raw[key];
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
      const grant =
        form.grant_type === "authorization_code" ||
        form.grant_type === "refresh_token"
          ? form.grant_type
          : null;
      try {
        switch (grant) {
          case "authorization_code":
            return await tokenOk(
              reply,
              await exchangeAuthorizationCode(deps.db, {
                clientId: form.client_id ?? "",
                clientSecret: form.client_secret ?? "",
                code: form.code ?? "",
                redirectUri: form.redirect_uri ?? "",
                codeVerifier: form.code_verifier ?? "",
              }),
            );
          case "refresh_token":
            return await tokenOk(
              reply,
              await refreshAccessToken(deps.db, {
                clientId: form.client_id ?? "",
                clientSecret: form.client_secret ?? "",
                refreshToken: form.refresh_token ?? "",
              }),
            );
          default:
            return await oauthError(reply, 400, "unsupported_grant_type");
        }
      } catch (error) {
        if (error instanceof AppError && error.code === "invalid_input") {
          return await oauthError(reply, 400, "invalid_grant");
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
