import { AppError, publicError, rowIdSchema } from "@anygriddb/core";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  type Actor,
  createRecords,
  deleteRecords,
  getRecord,
  listBases,
  listRecords,
  listTables,
  openApiDocument,
  type PublicApiDeps,
  updateRecords,
  writeBodySchema,
} from "../public-api/index.js";

function toolError(error: unknown): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  const body = publicError(
    error instanceof AppError ? error : new AppError("internal_error"),
  );
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({
          error: body.message,
          code: body.code,
          ...(body.detail === undefined ? {} : { detail: body.detail }),
        }),
      },
    ],
  };
}

function ok(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
    structuredContent: data as Record<string, unknown>,
  };
}

/** A write's body as REST takes it, with the table and a reason beside it. */
const writeRecordsSchema = z.object({
  tableId: z.uuid(),
  ...writeBodySchema.shape,
  reason: z.string().max(500).optional(),
});

/**
 * Registers the record tools on an MCP server, each run as `actor`: the
 * lower of its token's scope and its owner's roles, as on the REST API.
 * A read-only token is not offered the tools that write.
 */
export function registerPublicApiTools(
  server: McpServer,
  deps: PublicApiDeps,
  actor: Actor,
): void {
  const run = async <T>(body: (actor: Actor) => Promise<T>) => {
    try {
      return ok(await body(actor));
    } catch (error) {
      if (!(error instanceof AppError)) {
        deps.log(error, "mcp tool failed");
      }
      return toolError(error);
    }
  };
  const reads = { readOnlyHint: true, openWorldHint: false } as const;

  server.registerTool(
    "list_bases",
    {
      title: "List bases",
      description: "List bases the API token can see (id, name, role).",
      inputSchema: z.object({}),
      annotations: reads,
    },
    async () => run((actor) => listBases(deps, actor)),
  );

  server.registerTool(
    "list_tables",
    {
      title: "List tables",
      description: "List tables and field metadata for a base.",
      inputSchema: z.object({ baseId: z.uuid() }),
      annotations: reads,
    },
    async ({ baseId }) => run((actor) => listTables(deps, actor, baseId)),
  );

  server.registerTool(
    "get_openapi",
    {
      title: "OpenAPI document",
      description: "OpenAPI 3.1 document for a base (same as /openapi.json).",
      inputSchema: z.object({ baseId: z.uuid() }),
      annotations: reads,
    },
    async ({ baseId }) => run((actor) => openApiDocument(deps, actor, baseId)),
  );

  server.registerTool(
    "list_records",
    {
      title: "List records",
      description:
        "Page records of a table. limit 1..1000 (default 100). Optional view, sort, filter JSON, search, fields, fieldKey.",
      inputSchema: z.object({
        tableId: z.uuid(),
        limit: z.number().int().min(1).max(1000).optional(),
        offset: z.number().int().min(0).optional(),
        view: z.uuid().optional(),
        sort: z.string().max(500).optional(),
        filter: z.string().max(20_000).optional(),
        search: z.string().trim().min(1).max(200).optional(),
        fields: z.string().max(5_000).optional(),
        fieldKey: z.enum(["name", "label"]).optional(),
        timeZone: z.string().max(64).optional(),
      }),
      annotations: reads,
    },
    async ({ tableId, ...query }) =>
      run((actor) => listRecords(deps, actor, tableId, query)),
  );

  server.registerTool(
    "get_record",
    {
      title: "Get one record",
      description: "Fetch a single record by id.",
      inputSchema: z.object({
        tableId: z.uuid(),
        recordId: rowIdSchema,
        fieldKey: z.enum(["name", "label"]).optional(),
      }),
      annotations: reads,
    },
    async ({ tableId, recordId, fieldKey }) =>
      run((actor) =>
        getRecord(deps, actor, tableId, recordId, fieldKey ?? "name"),
      ),
  );

  if (actor.scope?.readOnly) return;

  server.registerTool(
    "create_records",
    {
      title: "Create records",
      description: "Create up to 100 records. Honours token write rights.",
      inputSchema: writeRecordsSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    },
    async ({ tableId, reason, ...body }) =>
      run((actor) => createRecords(deps, actor, tableId, body, reason)),
  );

  server.registerTool(
    "update_records",
    {
      title: "Update records",
      description:
        "Update up to 100 records (each needs id). Honours token write rights.",
      inputSchema: writeRecordsSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ tableId, reason, ...body }) =>
      run((actor) => updateRecords(deps, actor, tableId, body, reason)),
  );

  server.registerTool(
    "delete_records",
    {
      title: "Delete records",
      description:
        "Delete up to 100 records by id. Honours token write rights.",
      inputSchema: z.object({
        tableId: z.uuid(),
        recordIds: z.array(rowIdSchema).min(1).max(100),
        reason: z.string().max(500).optional(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ tableId, recordIds, reason }) =>
      run((actor) => deleteRecords(deps, actor, tableId, recordIds, reason)),
  );
}
