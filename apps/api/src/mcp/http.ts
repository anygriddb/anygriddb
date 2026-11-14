/**
 * The Model Context Protocol over Streamable HTTP at `/mcp`: the record
 * plane of the REST API, as tools an AI the operator runs can call. No
 * model is embedded. Stateless: one server and one transport per request.
 * Only a bearer `ag_…` token is read, never a session cookie, so a page
 * cannot act through a signed-in browser; a request a browser sends from
 * another origin is refused, as the protocol asks (DNS rebinding).
 */
import { AppError, publicError } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requestActor } from "../auth/access.js";
import type { Actor, PublicApiDeps } from "../public-api/index.js";
import type { Bus } from "../realtime/bus.js";
import { createAnyGridMcpServer } from "./server.js";

type Deps = { db: Database; bus: Bus; publicUrl: string };

function errorBody(error: AppError) {
  const body = publicError(error);
  return {
    error: body.message,
    code: body.code,
    ...(body.detail === undefined ? {} : { detail: body.detail }),
  };
}

/** The caller of a request, from its bearer token alone. */
async function mcpActor(
  db: Database,
  authorization: string | string[] | undefined,
): Promise<Actor | null> {
  const header = Array.isArray(authorization)
    ? authorization[0]
    : authorization;
  if (!header?.startsWith("Bearer ")) return null;
  const actor = await requestActor(db, { authorization: header }, undefined);
  // A session cookie is never passed, so the actor is the token's.
  return actor?.scope ? actor : null;
}

/** True when a browser sent the request from another origin than ours. */
function foreignOrigin(origin: string | undefined, publicUrl: string): boolean {
  return origin !== undefined && origin !== new URL(publicUrl).origin;
}

export function registerMcp(app: FastifyInstance, deps: Deps): void {
  const shared: PublicApiDeps = {
    db: deps.db,
    bus: deps.bus,
    publicUrl: deps.publicUrl,
    log: (error, message) => {
      app.log.error({ err: error }, message);
    },
  };

  const handle = async (request: FastifyRequest, reply: FastifyReply) => {
    if (foreignOrigin(request.headers.origin, deps.publicUrl)) {
      return reply.code(403).send(errorBody(new AppError("access_denied")));
    }
    let actor: Actor | null;
    try {
      actor = await mcpActor(deps.db, request.headers.authorization);
    } catch (error) {
      // An account without its second factor, for one.
      if (error instanceof AppError) {
        return reply.code(error.status).send(errorBody(error));
      }
      throw error;
    }
    if (!actor) {
      return reply
        .code(401)
        .header("www-authenticate", 'Bearer realm="anygriddb"')
        .send(errorBody(new AppError("unauthenticated")));
    }

    const server = createAnyGridMcpServer(shared, actor);
    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      // The tools answer once, with no progress to stream.
      enableJsonResponse: true,
    });
    await server.connect(transport);
    reply.hijack();
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } catch (error) {
      request.log.error({ err: error }, "mcp request failed");
      if (!reply.raw.headersSent) {
        reply.raw.statusCode = 500;
        reply.raw.setHeader("content-type", "application/json");
        reply.raw.end(
          JSON.stringify(errorBody(new AppError("internal_error"))),
        );
      }
      await transport.close();
      await server.close();
    }
  };

  app.post("/mcp", handle);
  app.get("/mcp", handle);
  app.delete("/mcp", handle);
}
