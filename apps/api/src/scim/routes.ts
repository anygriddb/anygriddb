/**
 * SCIM 2.0 over HTTP, under /scim/v2 (ADR 0038): what Okta, Microsoft
 * Entra ID, and other identity providers call to keep accounts and groups.
 * A provisioning token opens it; answers and errors are SCIM's.
 */
import {
  parseScimFilter,
  parseScimPatch,
  ScimError,
  scimErrorBody,
  scimList,
  scimPage,
  scimResourceTypes,
  scimSchemas,
  scimServiceProviderConfig,
} from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import type { FastifyInstance, FastifyReply } from "fastify";
import {
  createScimGroup,
  createScimUser,
  deleteScimGroup,
  deleteScimUser,
  getScimGroup,
  getScimUser,
  listScimGroups,
  listScimUsers,
  patchScimGroupById,
  patchScimUserById,
  replaceScimGroup,
  replaceScimUser,
  type ScimContext,
} from "./store.js";
import { scimActor } from "./tokens.js";

const CONTENT_TYPE = "application/scim+json; charset=utf-8";

type Query = {
  filter?: string;
  startIndex?: string;
  count?: string;
  excludedAttributes?: string;
  attributes?: string;
};
type Params = { id: string };

declare module "fastify" {
  interface FastifyRequest {
    scimActorId?: string;
  }
}

function send(reply: FastifyReply, status: number, body?: unknown) {
  reply.code(status).header("content-type", CONTENT_TYPE);
  return body === undefined ? reply.send() : reply.send(JSON.stringify(body));
}

/** Whether a request leaves group members out, as providers ask in lists. */
function withoutMembers(query: Query): boolean {
  const names = (text: string | undefined) =>
    (text ?? "").split(",").map((name) => name.trim().toLowerCase());
  if (names(query.excludedAttributes).includes("members")) return true;
  const only = names(query.attributes).filter(Boolean);
  return only.length > 0 && !only.includes("members");
}

export function registerScim(
  app: FastifyInstance,
  deps: { db: Database; publicUrl: string },
): void {
  const baseUrl = `${deps.publicUrl}/scim/v2`;
  void app.register(
    (scope, _options, done) => {
      // SCIM's own media type is JSON, parsed with the same protections. A
      // provider may send a content type with no body (a DELETE): no body.
      const json = scope.getDefaultJsonParser("error", "error");
      scope.removeContentTypeParser("application/json");
      scope.addContentTypeParser(
        ["application/json", "application/scim+json"],
        { parseAs: "string" },
        (request, raw, done) => {
          const body = typeof raw === "string" ? raw : raw.toString("utf8");
          if (body === "") {
            done(null, undefined);
            return;
          }
          void json(request, body, done);
        },
      );

      scope.addHook("onRequest", async (request, reply) => {
        const actor = await scimActor(deps.db, request.headers.authorization);
        if (!actor) {
          reply.header("www-authenticate", 'Bearer realm="scim"');
          return send(
            reply,
            401,
            scimErrorBody(new ScimError(401, "Invalid token")),
          );
        }
        request.scimActorId = actor;
        return undefined;
      });

      scope.setErrorHandler((error: unknown, request, reply) => {
        if (error instanceof ScimError) {
          return send(reply, error.status, scimErrorBody(error));
        }
        const status =
          typeof error === "object" &&
          error !== null &&
          "statusCode" in error &&
          typeof error.statusCode === "number"
            ? error.statusCode
            : 500;
        if (status >= 500)
          request.log.error({ err: error }, "scim request failed");
        const scimError =
          status === 413
            ? new ScimError(413, "Request too large")
            : status === 415
              ? new ScimError(415, "Unsupported media type")
              : status >= 400 && status < 500
                ? new ScimError(400, "Invalid request", "invalidSyntax")
                : new ScimError(500, "Internal error");
        return send(reply, scimError.status, scimErrorBody(scimError));
      });

      scope.setNotFoundHandler((_request, reply) =>
        send(
          reply,
          404,
          scimErrorBody(new ScimError(404, "Resource not found")),
        ),
      );

      const context = (actorId: string | undefined): ScimContext => {
        if (!actorId) throw new ScimError(401, "Invalid token");
        return { db: deps.db, actorId, baseUrl };
      };

      scope.get("/ServiceProviderConfig", (_request, reply) =>
        send(reply, 200, scimServiceProviderConfig(baseUrl)),
      );
      scope.get("/ResourceTypes", (_request, reply) => {
        const types = scimResourceTypes(baseUrl);
        return send(reply, 200, scimList(types, types.length, 1));
      });
      scope.get("/Schemas", (_request, reply) => {
        const schemas = scimSchemas(baseUrl);
        return send(reply, 200, scimList(schemas, schemas.length, 1));
      });

      scope.get<{ Querystring: Query }>("/Users", async (request, reply) => {
        const page = scimPage(request.query);
        const { total, resources } = await listScimUsers(
          context(request.scimActorId),
          parseScimFilter("user", request.query.filter),
          page,
        );
        return send(reply, 200, scimList(resources, total, page.startIndex));
      });
      scope.post("/Users", async (request, reply) => {
        const user = await createScimUser(
          context(request.scimActorId),
          request.body,
        );
        reply.header("location", user?.meta.location);
        return send(reply, 201, user);
      });
      scope.get<{ Params: Params }>("/Users/:id", async (request, reply) =>
        send(
          reply,
          200,
          await getScimUser(context(request.scimActorId), request.params.id),
        ),
      );
      scope.put<{ Params: Params }>("/Users/:id", async (request, reply) =>
        send(
          reply,
          200,
          await replaceScimUser(
            context(request.scimActorId),
            request.params.id,
            request.body,
          ),
        ),
      );
      scope.patch<{ Params: Params }>("/Users/:id", async (request, reply) =>
        send(
          reply,
          200,
          await patchScimUserById(
            context(request.scimActorId),
            request.params.id,
            parseScimPatch(request.body),
          ),
        ),
      );
      scope.delete<{ Params: Params }>("/Users/:id", async (request, reply) => {
        await deleteScimUser(context(request.scimActorId), request.params.id);
        return send(reply, 204);
      });

      scope.get<{ Querystring: Query }>("/Groups", async (request, reply) => {
        const page = scimPage(request.query);
        const { total, resources } = await listScimGroups(
          context(request.scimActorId),
          parseScimFilter("group", request.query.filter),
          page,
          !withoutMembers(request.query),
        );
        return send(reply, 200, scimList(resources, total, page.startIndex));
      });
      scope.post("/Groups", async (request, reply) => {
        const group = await createScimGroup(
          context(request.scimActorId),
          request.body,
        );
        reply.header("location", group?.meta.location);
        return send(reply, 201, group);
      });
      scope.get<{ Params: Params; Querystring: Query }>(
        "/Groups/:id",
        async (request, reply) =>
          send(
            reply,
            200,
            await getScimGroup(
              context(request.scimActorId),
              request.params.id,
              !withoutMembers(request.query),
            ),
          ),
      );
      scope.put<{ Params: Params }>("/Groups/:id", async (request, reply) =>
        send(
          reply,
          200,
          await replaceScimGroup(
            context(request.scimActorId),
            request.params.id,
            request.body,
          ),
        ),
      );
      scope.patch<{ Params: Params }>("/Groups/:id", async (request, reply) => {
        await patchScimGroupById(
          context(request.scimActorId),
          request.params.id,
          parseScimPatch(request.body),
        );
        return send(reply, 204);
      });
      scope.delete<{ Params: Params }>(
        "/Groups/:id",
        async (request, reply) => {
          await deleteScimGroup(
            context(request.scimActorId),
            request.params.id,
          );
          return send(reply, 204);
        },
      );
      done();
    },
    { prefix: "/scim/v2" },
  );
}
