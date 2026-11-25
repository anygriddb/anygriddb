import {
  AppError,
  type ErrorCode,
  publicError,
  type PublicError,
  rowIdSchema,
} from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { requestActor } from "./auth/access.js";
import { SESSION_COOKIE } from "./auth/session.js";
import { budgetFor } from "./read-budget.js";
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
  recordQuerySchema,
  transitionRecord,
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
  // What a schema refuses is what the caller sent, wherever it was read.
  if (error instanceof z.ZodError) {
    const refused = new AppError("invalid_input");
    return { status: refused.status, body: publicError(refused) };
  }
  return { status: 500, body: publicError(error) };
}

/** What a request names in its path or its query: a mismatch is the caller's. */
function read<Schema extends z.ZodType>(
  schema: Schema,
  value: unknown,
  refusal: ErrorCode = "invalid_input",
): z.infer<Schema> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AppError(refusal);
  return parsed.data;
}

const baseParams = z.object({ baseId: z.uuid() });
const tableParams = z.object({ tableId: z.uuid() });

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
    result = await body({ ...actor, readBudget: budgetFor(reply.raw) });
  } catch (error) {
    const { status, body: failed } = failure(error);
    if (status >= 500) request.log.error({ err: error }, "api request failed");
    return reply.code(status).send(errorBody(failed));
  }
  return reply.send(result);
}

/**
 * The reason a write gives, percent-encoded so that a header can carry any
 * letter. One that does not decode is kept as it was sent: a plain "100%"
 * is a reason, not a mistake.
 */
function reasonOf(request: FastifyRequest): string | undefined {
  const header = request.headers["x-reason"];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return undefined;
  let reason = value;
  try {
    reason = decodeURIComponent(value);
  } catch (error) {
    if (!(error instanceof URIError)) throw error;
  }
  return reason.slice(0, 500);
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
      const { baseId } = read(baseParams, request.params);
      return listTables(shared, actor, baseId);
    }),
  );

  app.get("/api/v1/bases/:baseId/openapi.json", (request, reply) =>
    run(request, reply, deps, async (actor) => {
      const { baseId } = read(baseParams, request.params);
      return openApiDocument(shared, actor, baseId);
    }),
  );

  app.get("/api/v1/tables/:tableId/records", (request, reply) =>
    run(request, reply, deps, async (actor) => {
      const { tableId } = read(tableParams, request.params);
      return listRecords(shared, actor, tableId, request.query);
    }),
  );

  app.get("/api/v1/tables/:tableId/records/:recordId", (request, reply) =>
    run(request, reply, deps, async (actor) => {
      const { tableId } = read(tableParams, request.params);
      const { recordId } = read(
        z.object({ recordId: rowIdSchema }),
        request.params,
        "invalid_record_id",
      );
      const { fieldKey } = read(
        recordQuerySchema,
        request.query,
        "invalid_query",
      );
      return getRecord(shared, actor, tableId, recordId, fieldKey);
    }),
  );

  app.post("/api/v1/tables/:tableId/records", (request, reply) =>
    run(request, reply, deps, async (actor) => {
      const { tableId } = read(tableParams, request.params);
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
      const { tableId } = read(tableParams, request.params);
      return updateRecords(
        shared,
        actor,
        tableId,
        request.body,
        reasonOf(request),
      );
    }),
  );

  app.post(
    "/api/v1/tables/:tableId/records/:recordId/transition",
    (request, reply) =>
      run(request, reply, deps, async (actor) => {
        const { tableId } = read(tableParams, request.params);
        const { recordId } = read(
          z.object({ recordId: rowIdSchema }),
          request.params,
          "invalid_record_id",
        );
        return transitionRecord(shared, actor, tableId, recordId, request.body);
      }),
  );

  app.delete("/api/v1/tables/:tableId/records", (request, reply) =>
    run(request, reply, deps, async (actor) => {
      const { tableId } = read(tableParams, request.params);
      // Named twice, the parameter is a list and no longer a text.
      const raw = read(
        z.string().default(""),
        (request.query as { records?: unknown }).records,
        "invalid_record_id",
      );
      const ids = recordIds(raw);
      if (!ids) throw new AppError("invalid_record_id");
      return deleteRecords(shared, actor, tableId, ids, reasonOf(request));
    }),
  );
}
