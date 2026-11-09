import { ERROR_CODES, isRelationType, isWritableType } from "@anygriddb/core";
import { publicColumns } from "../trpc/catalog-router.js";
import { MAX_RECORDS } from "./types.js";

/**
 * Exact numbers travel as decimal text (ADR 0023): a JSON number would
 * round through a float. Writes accept either form.
 */
function exactNumberSchema(base: Record<string, unknown>) {
  return {
    ...base,
    type: "string",
    format: "decimal",
    pattern: "^-?\\d+(\\.\\d+)?$",
  };
}

/** JSON type of a field in OpenAPI terms. */
function fieldSchema(
  column: ReturnType<typeof publicColumns>[number],
): Record<string, unknown> {
  const options = (
    column.config as { options?: Array<{ name: string }> }
  ).options?.map((option) => option.name);
  const readOnly =
    !isWritableType(column.fieldType) && !isRelationType(column.fieldType);
  const base: Record<string, unknown> = {
    description: column.description ?? column.label,
    ...(readOnly ? { readOnly: true } : {}),
  };
  switch (column.fieldType) {
    case "number":
      return exactNumberSchema(base);
    case "rating":
    case "duration":
    case "autonumber":
      return { ...base, type: "number" };
    case "boolean":
      return { ...base, type: "boolean" };
    case "date":
      return { ...base, type: "string", format: "date" };
    case "datetime":
    case "created_time":
    case "last_modified_time":
      return { ...base, type: "string", format: "date-time" };
    case "email":
      return { ...base, type: "string", format: "email" };
    case "url":
      return { ...base, type: "string", format: "uri" };
    case "single_select":
      return { ...base, type: "string", ...(options ? { enum: options } : {}) };
    case "multi_select":
      return {
        ...base,
        type: "array",
        items: { type: "string", ...(options ? { enum: options } : {}) },
      };
    case "user":
      return {
        ...base,
        type: "array",
        items: { type: "string", format: "uuid" },
      };
    case "created_by":
    case "last_modified_by":
      return { ...base, type: "string", format: "uuid" };
    case "attachment":
      return {
        ...base,
        type: "array",
        items: {
          oneOf: [
            { type: "string", description: "Attachment key (write)" },
            { $ref: "#/components/schemas/Attachment" },
          ],
        },
      };
    case "relation_one_to_many":
    case "relation_many_to_many":
      return {
        ...base,
        type: "array",
        items: {
          oneOf: [
            { type: "string", format: "uuid" },
            { $ref: "#/components/schemas/Link" },
          ],
        },
      };
    default:
      // A computed number (formula, lookup, rollup) is exact.
      if (column.kind === "number") return exactNumberSchema(base);
      if (column.kind === "boolean") return { ...base, type: "boolean" };
      if (column.kind === "array") return { ...base, type: "array", items: {} };
      return { ...base, type: "string" };
  }
}

export function buildOpenApi(
  base: { id: string; name: string },
  tableList: Array<{
    id: string;
    name: string;
    /** A client's table: ids are its key, and writes compare what was read. */
    external?: boolean;
    columns: ReturnType<typeof publicColumns>;
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
          enum: ["draft", "submitted", "locked", "signed"],
        },
        fields: { $ref: `#/components/schemas/${schemaName}` },
      },
    };
    const writeRequest = {
      type: "object",
      required: ["records"],
      properties: {
        records: {
          type: "array",
          maxItems: MAX_RECORDS,
          items: {
            type: "object",
            properties: {
              id: recordId,
              fields: { $ref: `#/components/schemas/${schemaName}` },
              ...(table.external
                ? {
                    expected: {
                      $ref: `#/components/schemas/${schemaName}`,
                      description:
                        "What you last read in the fields you change: the update is refused (409, source_conflict) if they changed since",
                    },
                  }
                : {}),
            },
          },
        },
        typecast: {
          type: "boolean",
          description:
            "Convert loose values (text, numbers with commas, option names)",
        },
        fieldKey: { type: "string", enum: ["name", "label"] },
      },
    };
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
        parameters: [
          {
            name: "limit",
            in: "query",
            schema: { type: "integer", maximum: 1000, default: 100 },
          },
          {
            name: "offset",
            in: "query",
            schema: { type: "integer", default: 0 },
          },
          {
            name: "view",
            in: "query",
            schema: { type: "string", format: "uuid" },
          },
          {
            name: "sort",
            in: "query",
            schema: { type: "string" },
            description: "Comma list, `-` for descending",
          },
          {
            name: "filter",
            in: "query",
            schema: { type: "string" },
            description: "JSON filter group with field names",
          },
          { name: "search", in: "query", schema: { type: "string" } },
          {
            name: "fields",
            in: "query",
            schema: { type: "string" },
            description: "Comma list of fields to return",
          },
          {
            name: "fieldKey",
            in: "query",
            schema: { type: "string", enum: ["name", "label"] },
          },
        ],
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
        requestBody: {
          required: true,
          content: { "application/json": { schema: writeRequest } },
        },
        responses: { "200": { description: "Created ids" }, ...errors },
      },
      patch: {
        summary: `Update ${table.name} records`,
        tags: [table.name],
        requestBody: {
          required: true,
          content: { "application/json": { schema: writeRequest } },
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
            schema: { type: "string" },
            description:
              "Comma list of ids, or a JSON array of them, 100 at most",
          },
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
