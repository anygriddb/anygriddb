/**
 * How the tests that walk every procedure of the router build each one's
 * input, from the shape it takes: what it requires, nothing more. Inputs
 * a shape alone does not give are written by hand.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  declarationSchema,
  type Declaration,
  type ExceptionKey,
} from "../access/declaration.js";
import type { TestBrowser } from "./caller.test-helpers.js";
import { appRouter } from "./router.js";

/** The reasons a procedure answers someone who is not signed in. */
export const OPEN_EXCEPTIONS: ReadonlySet<ExceptionKey> = new Set([
  "signIn",
  "invitation",
  "publicLink",
  "unsubscribe",
]);

export type Schema = {
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  enum?: unknown[];
  const?: unknown;
  anyOf?: Schema[];
  oneOf?: Schema[];
  allOf?: Schema[];
  format?: string;
  contentEncoding?: string;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  exclusiveMinimum?: number;
  minItems?: number;
};

/** Texts tried against a pattern, the plainest first. */
const TEXTS = [
  "asked",
  "000000",
  "A".repeat(16),
  "a".repeat(22),
  "a".repeat(43),
];

function text(schema: Schema): string {
  switch (schema.format) {
    case "uuid":
      return randomUUID();
    case "email":
      return "nobody@example.org";
    case "uri":
    case "url":
      return "https://example.org/";
    case "date-time":
      return "2026-01-01T00:00:00.000Z";
    case "date":
      return "2026-01-01";
    default:
  }
  if (schema.format === "base64" || schema.contentEncoding === "base64") {
    return "YXNrZWQ=";
  }
  if (schema.pattern !== undefined) {
    const pattern = new RegExp(schema.pattern, "u");
    const fits = TEXTS.find(
      (candidate) =>
        pattern.test(candidate) &&
        candidate.length >= (schema.minLength ?? 0) &&
        candidate.length <= (schema.maxLength ?? candidate.length),
    );
    if (fits === undefined) {
      throw new Error(`No text of the walk fits ${schema.pattern}`);
    }
    return fits;
  }
  return "asked"
    .padEnd(schema.minLength ?? 0, "x")
    .slice(0, schema.maxLength ?? 80);
}

/** A value of the shape a schema asks for: what it requires, nothing more. */
export function sample(schema: Schema | undefined): unknown {
  if (!schema) return null;
  if (schema.const !== undefined) return schema.const;
  if (schema.enum && schema.enum.length > 0) return schema.enum[0];
  const choice = schema.anyOf ?? schema.oneOf;
  if (choice && choice.length > 0) {
    return sample(choice.find((option) => option.type !== "null") ?? choice[0]);
  }
  if (schema.allOf) {
    return Object.assign({}, ...schema.allOf.map((part) => sample(part)));
  }
  const type = Array.isArray(schema.type)
    ? schema.type.find((name) => name !== "null")
    : schema.type;
  switch (type) {
    case "object":
      return Object.fromEntries(
        (schema.required ?? []).map((name) => [
          name,
          sample(schema.properties?.[name]),
        ]),
      );
    case "array":
      return Array.from({ length: Math.max(schema.minItems ?? 0, 1) }, () =>
        sample(schema.items),
      );
    case "string":
      return text(schema);
    case "integer":
    case "number":
      return (
        schema.minimum ??
        (schema.exclusiveMinimum === undefined
          ? 1
          : schema.exclusiveMinimum + 1)
      );
    case "boolean":
      return false;
    default:
      return null;
  }
}

/**
 * Inputs a shape alone does not give: a rule of the schema asks that two
 * of its parts agree, or that a text be an address.
 */
export const BY_HAND: Record<string, unknown> = {
  "admin.oauthClients.create": {
    name: "Asked",
    redirectUris: ["https://client.example.org/back"],
  },
  "catalog.createTable": {
    baseId: randomUUID(),
    name: "Asked",
    columns: [{ name: "asked", fieldType: "text" }],
  },
  "catalog.createWebhook": {
    tableId: randomUUID(),
    kind: "http",
    target: "https://hooks.example.org/in",
    events: ["insert"],
  },
  "catalog.importAirtable": {
    base: `app${"a".repeat(14)}`,
    token: `pat${"a".repeat(20)}`,
  },
  "dashboards.upsertWidget": {
    dashboardId: randomUUID(),
    title: "Asked",
    kind: "metric",
    config: { tableId: randomUUID(), column: "asked", fn: "count_all" },
  },
  "rows.setLinks": {
    tableId: randomUUID(),
    rowId: randomUUID(),
    column: "asked",
    targetIds: [],
  },
  "rows.importCommit": {
    importId: "a".repeat(22),
    target: { kind: "new", baseId: randomUUID(), name: "Asked" },
    mapping: [{ source: 0, create: { label: "Asked", fieldType: "text" } }],
  },
};

/** A procedure of the router, with an input it takes and what it asks. */
export type Walked = {
  path: string;
  type: "query" | "mutation" | "subscription";
  input: unknown;
  declaration: Declaration;
};

/** The JSON shape of a procedure's input. */
export function inputShape(input: unknown): Schema {
  return z.toJSONSchema(input as z.ZodType, {
    unrepresentable: "any",
    io: "input",
  }) as Schema;
}

/** Every procedure of the router, with an input it takes. */
export function walkRouter(
  byHand: Record<string, unknown> = BY_HAND,
): Walked[] {
  return Object.entries(
    appRouter._def.procedures as unknown as Record<
      string,
      {
        _def: {
          type: Walked["type"];
          inputs?: unknown[];
          meta?: unknown;
        };
      }
    >,
  ).map(([path, procedure]) => {
    const input = procedure._def.inputs?.[0];
    return {
      path,
      type: procedure._def.type,
      input:
        path in byHand
          ? byHand[path]
          : input === undefined
            ? undefined
            : sample(inputShape(input)),
      declaration: declaredBy(path, procedure._def.meta),
    };
  });
}

/** A procedure's declaration, or a failure that names the procedure. */
function declaredBy(path: string, meta: unknown): Declaration {
  const parsed = declarationSchema.safeParse(meta);
  if (!parsed.success) {
    throw new Error(
      `${path} declares nothing it asks: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

/** Calls a procedure by its path, from a browser. */
export function ask(page: TestBrowser, path: string, input: unknown) {
  let target: unknown = page.call();
  for (const step of path.split(".")) {
    target = (target as Record<string, unknown>)[step];
  }
  return (target as (input?: unknown) => Promise<unknown>)(input);
}
