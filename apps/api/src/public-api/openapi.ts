import {
  apiValueNote,
  apiValueSchema,
  ERROR_CODES,
  takesApiWrites,
} from "@anygriddb/core";
import { publicColumns } from "../trpc/catalog-shared.js";
import { z } from "zod";
import { listQuerySchema, MAX_RECORDS, recordQuerySchema } from "./types.js";

/**
 * The parameters of a query, as the schema it is read with describes them:
 * the document cannot say otherwise than the server does.
 */
function queryParameters(schema: z.ZodType): unknown[] {
  const described = z.toJSONSchema(schema, { io: "input" }) as {
    properties?: Record<string, { description?: string }>;
  };
  return Object.entries(described.properties ?? {}).map(
    ([name, { description, ...rest }]) => ({
      name,
      in: "query",
      ...(description === undefined ? {} : { description }),
      schema: rest,
    }),
  );
}

/** Why a write is made, where a field asks for it. */
const REASON_HEADER = {
  name: "X-Reason",
  in: "header",
  schema: { type: "string" },
  description:
    "Why the change is made. A field that requires a reason refuses a write without one (400 `reason_required`). Percent-encode it to carry what a header cannot; its first 500 characters are kept.",
};

/** JSON type of a field in OpenAPI terms. */
function fieldSchema(
  column: ReturnType<typeof publicColumns>[number],
): Record<string, unknown> {
  const options = (
    column.config as { options?: Array<{ name: string }> }
  ).options?.map((option) => option.name);
  const description = column.description ?? column.label;
  const note = apiValueNote(column.fieldType);
  return {
    description: note === undefined ? description : `${description}. ${note}`,
    ...(takesApiWrites(column.fieldType) ? {} : { readOnly: true }),
    ...apiValueSchema({
      fieldType: column.fieldType,
      kind: column.kind,
      ...(options ? { options } : {}),
    }),
  };
}

export function buildOpenApi(
  base: { id: string; name: string },
  tableList: Array<{
    id: string;
    name: string;
    /** A client's table: ids are its key, and writes compare what was read. */
    external?: boolean;
    columns: ReturnType<typeof publicColumns>;
    /** The keys of its circuit's states and steps; compliance's otherwise. */
    circuit?: { states: string[]; steps: string[] };
  }>,
  serverUrl: string,
) {
  const paths: Record<string, unknown> = {};
  const schemas: Record<string, unknown> = {
    Link: {
      type: "object",
      properties: {
        id: { type: "string", format: "uuid" },
        label: { type: "string" },
      },
    },
    Attachment: {
      type: "object",
      properties: {
        key: { type: "string" },
        filename: { type: "string" },
        mime: { type: "string" },
        size: { type: "integer" },
        thumb: { type: "boolean" },
      },
    },
    Error: {
      type: "object",
      required: ["error", "code"],
      properties: {
        error: { type: "string", description: "English message, for people" },
        code: {
          type: "string",
          enum: ERROR_CODES,
          description: "Stable code, for programs",
        },
        detail: {
          type: "string",
          description: "What the error is about, such as a field name",
        },
      },
    },
  };
  // The routes that lead to the tables, and to this document.
  const json = (schema: unknown) => ({ "application/json": { schema } });
  const text = { type: "string" };
  const flag = { type: "boolean" };
  const refused = {
    "401": { description: "Missing or invalid token" },
    "404": { description: "Unknown or unreadable base" },
    "429": { description: "Rate limited" },
  };
  paths["/bases"] = {
    get: {
      summary: "List the bases the token reads",
      tags: ["Bases"],
      responses: {
        "200": {
          description: "Bases, each with the role the token has on it",
          content: json({
            type: "object",
            properties: {
              bases: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string", format: "uuid" },
                    name: text,
                    role: {
                      type: ["string", "null"],
                      description:
                        "owner, editor, commenter or viewer, or the names of the roles an administrator made that apply, joined by +",
                    },
                    permissions: {
                      type: "array",
                      items: { type: "string" },
                      description: "What the roles that apply give on the base",
                    },
                  },
                },
              },
            },
          }),
        },
        "401": refused["401"],
        "429": refused["429"],
      },
    },
  };
  paths[`/bases/${base.id}/tables`] = {
    get: {
      summary: `List the tables of ${base.name}, with their fields`,
      tags: ["Bases"],
      responses: {
        "200": {
          description: "Tables the token reads, in the base's order",
          content: json({
            type: "object",
            properties: {
              tables: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string", format: "uuid" },
                    name: text,
                    fields: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          name: text,
                          label: text,
                          type: text,
                          kind: text,
                          primary: flag,
                          required: flag,
                          readOnly: flag,
                          config: { type: "object" },
                        },
                      },
                    },
                  },
                },
              },
            },
          }),
        },
        ...refused,
      },
    },
  };
  paths[`/bases/${base.id}/openapi.json`] = {
    get: {
      summary: "This document",
      tags: ["Bases"],
      responses: {
        "200": {
          description: "OpenAPI 3.1, written for the tables the token reads",
          content: json({ type: "object" }),
        },
        ...refused,
      },
    },
  };
  for (const table of tableList) {
    const schemaName = `Table_${table.id.replace(/-/g, "")}`;
    const recordId = table.external
      ? {
          type: "string",
          description:
            "The client table's key as text; a key of several columns as JSON",
        }
      : { type: "string", format: "uuid" };
    schemas[schemaName] = {
      type: "object",
      title: table.name,
      properties: Object.fromEntries(
        table.columns.map((column) => [column.name, fieldSchema(column)]),
      ),
    };
    const record = {
      type: "object",
      properties: {
        id: recordId,
        createdTime: { type: "string", format: "date-time" },
        lastModifiedTime: { type: "string", format: "date-time" },
        status: {
          type: "string",
          description: "The record's state in its table's circuit",
          enum: table.circuit?.states ?? [
            "draft",
            "submitted",
            "locked",
            "signed",
          ],
        },
        fields: { $ref: `#/components/schemas/${schemaName}` },
      },
    };
    // As `createBodySchema` and `updateBodySchema` read them: a key either
    // does not name is refused, and a new record's id is the instance's.
    const fields = { $ref: `#/components/schemas/${schemaName}` };
    const writeRequest = (items: {
      required: string[];
      properties: Record<string, unknown>;
    }) => ({
      type: "object",
      required: ["records"],
      additionalProperties: false,
      properties: {
        records: {
          type: "array",
          minItems: 1,
          maxItems: MAX_RECORDS,
          items: { type: "object", additionalProperties: false, ...items },
        },
        typecast: {
          type: "boolean",
          description:
            "Read loose values as their field keeps them (text, numbers, dates, option names). Nothing is cut, rounded, or guessed: a value that cannot be read exactly, such as 1,234 whose comma could be a decimal or a thousands separator, is refused as invalid_cell; a date such as 03/04/2026 that reads two ways, on a field with no date format, is refused as ambiguous_date",
        },
        fieldKey: { type: "string", enum: ["name", "label"] },
      },
    });
    const createRequest = writeRequest({
      required: ["fields"],
      properties: { fields },
    });
    const updateRequest = writeRequest({
      required: ["id", "fields"],
      properties: {
        id: recordId,
        fields,
        expected: {
          ...fields,
          description: `What you last read in the fields you change: the update is refused (409, ${table.external ? "source_conflict" : "row_conflict"}) if they changed since. Left out, the update is not compared`,
        },
      },
    });
    const errors = {
      "400": {
        description: "Invalid request",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/Error" },
          },
        },
      },
      "401": { description: "Missing or invalid token" },
      "403": { description: "Role or token scope refuses the action" },
      "404": { description: "Unknown or unreadable table" },
      "409": {
        description: table.external
          ? "Row changed since it was read, gone, held by another write, or a value already used"
          : "Row locked or signed",
      },
      "429": { description: "Rate limited" },
    };
    paths[`/tables/${table.id}/records`] = {
      get: {
        summary: `List ${table.name}`,
        tags: [table.name],
        parameters: queryParameters(listQuerySchema),
        responses: {
          "200": {
            description: "Records",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    records: { type: "array", items: record },
                    total: { type: "integer" },
                    offset: { type: "integer" },
                  },
                },
              },
            },
          },
          ...errors,
        },
      },
      post: {
        summary: `Create ${table.name} records`,
        tags: [table.name],
        parameters: [REASON_HEADER],
        requestBody: {
          required: true,
          content: { "application/json": { schema: createRequest } },
        },
        responses: { "200": { description: "Created ids" }, ...errors },
      },
      patch: {
        summary: `Update ${table.name} records`,
        tags: [table.name],
        parameters: [REASON_HEADER],
        requestBody: {
          required: true,
          content: { "application/json": { schema: updateRequest } },
        },
        responses: { "200": { description: "Updated ids" }, ...errors },
      },
      delete: {
        summary: `Delete ${table.name} records`,
        tags: [table.name],
        parameters: [
          {
            name: "records",
            in: "query",
            required: true,
            schema: { type: "string", minLength: 1 },
            description:
              "Comma list of ids, or a JSON array of them, 100 at most",
          },
          REASON_HEADER,
        ],
        responses: { "200": { description: "Deleted ids" }, ...errors },
      },
    };
    paths[`/tables/${table.id}/records/{recordId}`] = {
      get: {
        summary: `Get one ${table.name} record`,
        tags: [table.name],
        parameters: [
          {
            name: "recordId",
            in: "path",
            required: true,
            schema: recordId,
          },
          ...queryParameters(recordQuerySchema),
        ],
        responses: {
          "200": {
            description: "Record",
            content: { "application/json": { schema: record } },
          },
          ...errors,
        },
      },
    };
    paths[`/tables/${table.id}/records/{recordId}/transition`] = {
      post: {
        summary: `Take a step of a ${table.name} record's circuit`,
        description:
          "Moves the record by one step of its table's circuit, for the caller's roles. A step that asks a signature is taken in the application.",
        tags: [table.name],
        parameters: [
          { name: "recordId", in: "path", required: true, schema: recordId },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["transition"],
                properties: {
                  transition: {
                    type: "string",
                    enum: table.circuit?.steps ?? [
                      "submit",
                      "lock",
                      "sign",
                      "unlock",
                    ],
                  },
                  reason: { type: "string", minLength: 1, maxLength: 500 },
                },
                additionalProperties: false,
              },
            },
          },
        },
        responses: {
          "200": { description: "The state the record left and took" },
          ...errors,
        },
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: `AnyGridDB · ${base.name}`,
      version: "1",
      description:
        "Generated from the base schema. Authenticate with `Authorization: Bearer ag_…`.",
    },
    servers: [{ url: `${serverUrl}/api/v1` }],
    security: [{ bearer: [] }],
    components: {
      securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
      schemas,
    },
    paths,
  };
}
