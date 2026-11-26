/**
 * What an application talks to (ADR 0094, ADR 0098): where it finds the
 * addresses of the grant, where it exchanges a code or a refresh token,
 * and where it gives a grant back. Consent lives in the app (session and
 * tRPC); these take form bodies from the application itself.
 */
import { declaredRoute } from "../access/routes.js";
import type { Database } from "@anygriddb/db";
import { AppError, trimEndRun } from "@anygriddb/core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  CLIENT_REFUSED,
  exchangeAuthorizationCode,
  refreshAccessToken,
  revokeGrantToken,
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

/** The ways a client proves itself here, as the metadata names them. */
const CLIENT_AUTH_METHODS = ["client_secret_basic", "client_secret_post"];

/**
 * What an application reads to find its way (RFC 8414): the addresses of
 * the grant and what they take, all on the address people open.
 */
export function authorizationServerMetadata(publicUrl: string) {
  const issuer = trimEndRun(publicUrl, "/");
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: CLIENT_AUTH_METHODS,
    revocation_endpoint_auth_methods_supported: CLIENT_AUTH_METHODS,
  };
}

type ClientProof =
  | { clientId: string; clientSecret: string; header: boolean }
  /** A header that is no Basic one, or one that cannot be read. */
  | "unreadable"
  /** A secret in the header and another in the body. */
  | "twice";

/** One part of a Basic header: form-encoded, as RFC 6749 section 2.3.1 asks. */
function basicPart(value: string): string {
  return decodeURIComponent(value.replaceAll("+", " "));
}

/**
 * The client's id and secret, from the `Authorization: Basic` header or
 * from the form: one or the other, as a client that sent both would be
 * guessing which is read.
 */
export function clientProof(
  authorization: string | undefined,
  form: Form,
): ClientProof {
  if (authorization === undefined) {
    return {
      clientId: form.client_id ?? "",
      clientSecret: form.client_secret ?? "",
      header: false,
    };
  }
  if (form.client_secret !== undefined) return "twice";
  const [scheme, encoded, ...rest] = authorization.trim().split(/\s+/);
  if (scheme?.toLowerCase() !== "basic" || !encoded || rest.length > 0) {
    return "unreadable";
  }
  const pair = Buffer.from(encoded, "base64").toString("utf8");
  const colon = pair.indexOf(":");
  if (colon < 1) return "unreadable";
  try {
    return {
      clientId: basicPart(pair.slice(0, colon)),
      clientSecret: basicPart(pair.slice(colon + 1)),
      header: true,
    };
  } catch {
    // A percent sign that starts no escape.
    return "unreadable";
  }
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

/** The client did not prove itself: 401, naming the scheme it may use. */
function clientRefused(reply: FastifyReply) {
  return oauthError(
    reply.header("www-authenticate", 'Basic realm="oauth"'),
    401,
    "invalid_client",
  );
}

function refusedClient(error: unknown): boolean {
  return (
    error instanceof AppError &&
    error.code === "invalid_input" &&
    error.detail === CLIENT_REFUSED
  );
}

function tokenOk(reply: FastifyReply, body: TokenResponse) {
  return reply.code(200).header("cache-control", "no-store").send(body);
}

export function registerOauth(
  app: FastifyInstance,
  deps: { db: Database; publicUrl: string },
): void {
  app.get(
    "/.well-known/oauth-authorization-server",
    declaredRoute({ exception: "application" }),
    (_request, reply) =>
      reply
        .header("cache-control", "public, max-age=3600")
        .send(authorizationServerMetadata(deps.publicUrl)),
  );

  /**
   * Starts the browser grant: sends the person to the consent page with
   * the same query string. The SPA requires a session.
   */
  app.get(
    "/oauth/authorize",
    declaredRoute({ exception: "application" }),
    async (request, reply) => {
      const query = request.url.includes("?")
        ? request.url.slice(request.url.indexOf("?"))
        : "";
      return reply.redirect(`/oauth/consent${query}`);
    },
  );

  app.post(
    "/oauth/token",
    declaredRoute({ exception: "application" }),
    async (request: FastifyRequest, reply: FastifyReply) => {
      const form = formOf(request.body);
      const client = clientProof(request.headers.authorization, form);
      if (client === "twice") {
        return oauthError(
          reply,
          400,
          "invalid_request",
          "The client's secret goes in the header or in the body, not both.",
        );
      }
      if (client === "unreadable") return clientRefused(reply);
      try {
        switch (form.grant_type) {
          case "authorization_code":
            return await tokenOk(
              reply,
              await exchangeAuthorizationCode(deps.db, {
                ...client,
                code: form.code ?? "",
                redirectUri: form.redirect_uri ?? "",
                codeVerifier: form.code_verifier ?? "",
              }),
            );
          case "refresh_token":
            return await tokenOk(
              reply,
              await refreshAccessToken(deps.db, {
                ...client,
                refreshToken: form.refresh_token ?? "",
              }),
            );
          default:
            return await oauthError(reply, 400, "unsupported_grant_type");
        }
      } catch (error) {
        if (refusedClient(error)) return clientRefused(reply);
        if (error instanceof AppError && error.code === "invalid_input") {
          return await oauthError(reply, 400, "invalid_grant");
        }
        throw error;
      }
    },
  );

  app.post(
    "/oauth/revoke",
    declaredRoute({ exception: "application" }),
    async (request: FastifyRequest, reply: FastifyReply) => {
      const form = formOf(request.body);
      const client = clientProof(request.headers.authorization, form);
      if (client === "twice") return oauthError(reply, 400, "invalid_request");
      if (client === "unreadable") return clientRefused(reply);
      try {
        await revokeGrantToken(deps.db, {
          ...client,
          token: form.token ?? form.refresh_token ?? "",
        });
      } catch (error) {
        if (refusedClient(error)) return clientRefused(reply);
        if (!(error instanceof AppError && error.code === "invalid_input")) {
          throw error;
        }
      }
      // RFC 7009: 200 for a token that is already gone, or unknown.
      return reply.code(200).header("cache-control", "no-store").send({});
    },
  );
}
