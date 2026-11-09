import {
  AppError,
  publicError,
  type PublicError,
  rowIdSchema,
} from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { requestActor } from "./auth/access.js";
import { SESSION_COOKIE } from "./auth/session.js";
import type { Bus } from "./realtime/bus.js";
import {
  type Actor,
  createRecords,
  deleteRecords,
  getRecord,
  HttpError,
  listBases,
  listRecords,
  listTables,
  openApiDocument,
  type PublicApiDeps,
  recordIds,
  updateRecords,
} from "./public-api/index.js";

export { buildOpenApi } from "./public-api/index.js";

type Deps = { db: Database; bus: Bus; publicUrl: string };

function failure(error: unknown): { status: number; body: PublicError } {
  if (error instanceof HttpError) {
    return {
      status: error.status,
      body: publicError(
        new AppError(error.status === 404 ? "not_found" : "request_rejected"),
      ),
    };
  }
  if (error instanceof AppError) {
    return { status: error.status, body: publicError(error) };
  }
  return { status: 500, body: publicError(error) };
}

function errorBody(body: PublicError) {
  return {
    error: body.message,
    code: body.code,
    ...(body.detail === undefined ? {} : { detail: body.detail }),
  };
}

function apiDeps(deps: Deps, log: PublicApiDeps["log"]): PublicApiDeps {
  return {
    db: deps.db,
    bus: deps.bus,
    publicUrl: deps.publicUrl,
    log,
  };
}

async function run(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: Deps,
  body: (actor: Actor) => Promise<unknown>,
) {
  let result: unknown;
  try {
    const actor = await requestActor(
      deps.db,
      request.headers,
      request.cookies[SESSION_COOKIE],
    );
    if (!actor) {
      return await reply
        .code(401)
        .send(errorBody(publicError(new AppError("unauthenticated"))));
    }
    result = await body(actor);
  } catch (error) {
    const { status, body: failed } = failure(error);
    if (status >= 500) request.log.error({ err: error }, "api request failed");
    return reply.code(status).send(errorBody(failed));
  }
  return reply.send(result);
}

function reasonOf(request: FastifyRequest): string | undefined {
  const header = request.headers["x-reason"];
  const value = Array.isArray(header) ? header[0] : header;
  return value ? decodeURIComponent(value).slice(0, 500) : undefined;
}

export function registerRestApi(app: FastifyInstance, deps: Deps): void {
  const log: PublicApiDeps["log"] = (error, message) => {
    app.log.error({ err: error }, message);
  };
  const shared = apiDeps(deps, log);

  app.get("/api/v1/bases", (request, reply) =>
    run(request, reply, deps, (actor) => listBases(shared, actor)),
  );

  app.get("/api/v1/bases/:baseId/tables", (request, reply) =>
    run(request, reply, deps, async (actor) => {
      const { baseId } = z.object({ baseId: z.uuid() }).parse(request.params);
      return listTables(shared, actor, baseId);
    }),
  );

  app.get("/api/v1/bases/:baseId/openapi.json", (request, reply) =>
    run(request, reply, deps, async (actor) => {
      const { baseId } = z.object({ baseId: z.uuid() }).parse(request.params);
      return openApiDocument(shared, actor, baseId);
    }),
  );

  app.get("/api/v1/tables/:tableId/records", (request, reply) =>
    run(request, reply, deps, async (actor) => {
      const { tableId } = z.object({ tableId: z.uuid() }).parse(request.params);
      return listRecords(shared, actor, tableId, request.query);
    }),
  );

  app.get("/api/v1/tables/:tableId/records/:recordId", (request, reply) =>
    run(request, reply, deps, async (actor) => {
      const params = z
        .object({ tableId: z.uuid(), recordId: rowIdSchema })
        .parse(request.params);
      const fieldKey = z
        .enum(["name", "label"])
        .default("name")
        .parse((request.query as { fieldKey?: string }).fieldKey);
      return getRecord(
        shared,
        actor,
        params.tableId,
        params.recordId,
        fieldKey,
      );
    }),
  );

  app.post("/api/v1/tables/:tableId/records", (request, reply) =>
    run(request, reply, deps, async (actor) => {
      const { tableId } = z.object({ tableId: z.uuid() }).parse(request.params);
      return createRecords(
        shared,
        actor,
        tableId,
        request.body,
        reasonOf(request),
      );
    }),
  );

  app.patch("/api/v1/tables/:tableId/records", (request, reply) =>
    run(request, reply, deps, async (actor) => {
      const { tableId } = z.object({ tableId: z.uuid() }).parse(request.params);
      return updateRecords(
        shared,
        actor,
        tableId,
        request.body,
        reasonOf(request),
      );
    }),
  );

  app.delete("/api/v1/tables/:tableId/records", (request, reply) =>
    run(request, reply, deps, async (actor) => {
      const { tableId } = z.object({ tableId: z.uuid() }).parse(request.params);
      const raw = (request.query as { records?: string }).records ?? "";
      const ids = recordIds(raw);
      if (!ids) throw new AppError("invalid_record_id");
      return deleteRecords(shared, actor, tableId, ids, reasonOf(request));
    }),
  );
}
