import type { FilterKind } from "./filter";
import { isRelationType, isWritableType, type FieldType } from "./field-types";

/**
 * What a client is told of a field's value: its JSON schema in the API's
 * document and, for a field it writes, a value it takes, which the API's
 * page shows. One entry per field type, so that the two cannot disagree.
 */

/** A field as the API describes it. */
export type ApiField = {
  fieldType: FieldType;
  /** The kind it reads as, which types a computed field. */
  kind: FilterKind;
  /** The names of its options, for a list. */
  options?: readonly string[];
};

type JsonSchema = Record<string, unknown>;

type ApiValue = {
  /** Its JSON schema in OpenAPI terms, before its description. */
  schema: (field: ApiField) => JsonSchema;
  /** What a client must know to write it, beyond its schema. */
  note?: string;
  /**
   * A value a client writes, `text` standing for any text in the reader's
   * language; none for a field nobody writes.
   */
  example?: (field: ApiField, text: string) => unknown;
};

/**
 * Exact numbers travel as decimal text (ADR 0023): a JSON number would
 * round through a float. Writes accept either form, but an integer past
 * 2^53 has already been rounded as a JSON number, and is refused.
 */
const EXACT_NUMBER: JsonSchema = {
  type: "string",
  format: "decimal",
  pattern: "^-?\\d+(\\.\\d+)?$",
};

const STRING: JsonSchema = { type: "string" };
const NUMBER: JsonSchema = { type: "number" };
const BOOLEAN: JsonSchema = { type: "boolean" };
const INSTANT: JsonSchema = { type: "string", format: "date-time" };
const ACCOUNT: JsonSchema = { type: "string", format: "uuid" };

/** A field typed by what it reads as: a formula's result, a text. */
function byKind({ kind }: ApiField): JsonSchema {
  if (kind === "number") return EXACT_NUMBER;
  if (kind === "boolean") return BOOLEAN;
  if (kind === "array") return { type: "array", items: {} };
  return STRING;
}

function option({ options }: ApiField): JsonSchema {
  return { type: "string", ...(options ? { enum: options } : {}) };
}

const asText: ApiValue["example"] = (_field, text) => text;

function constant(value: unknown): ApiValue["example"] {
  return () => value;
}

const LINKS: ApiValue = {
  schema: () => ({
    type: "array",
    items: {
      oneOf: [
        { type: "string", format: "uuid" },
        { $ref: "#/components/schemas/Link" },
      ],
    },
  }),
  example: constant(["<record id>"]),
};

const API_VALUES = {
  text: { schema: byKind, example: asText },
  long_text: { schema: byKind, example: asText },
  number: {
    schema: () => EXACT_NUMBER,
    note: "Send an exact number as a string: a JSON integer past 2^53 is refused",
    example: constant("42.5"),
  },
  boolean: { schema: () => BOOLEAN, example: constant(true) },
  date: {
    schema: () => ({ type: "string", format: "date" }),
    example: constant("2026-11-07"),
  },
  datetime: {
    schema: () => INSTANT,
    example: constant("2026-11-07T09:30:00Z"),
  },
  single_select: {
    schema: option,
    example: ({ options }) => options?.[0] ?? "Option",
  },
  multi_select: {
    schema: (field) => ({ type: "array", items: option(field) }),
    example: ({ options }) => (options ?? []).slice(0, 2),
  },
  email: {
    schema: () => ({ type: "string", format: "email" }),
    example: constant("ada@example.org"),
  },
  url: {
    schema: () => ({ type: "string", format: "uri" }),
    example: constant("https://example.org"),
  },
  phone: { schema: byKind, example: constant("+33 1 23 45 67 89") },
  color: { schema: byKind, example: constant("#1f3fae") },
  place: { schema: byKind, example: constant("48.8566,2.3522") },
  json: { schema: byKind, example: constant('{"key": "value"}') },
  rating: { schema: () => NUMBER, example: constant(4) },
  duration: { schema: () => NUMBER, example: constant(5400) },
  user: {
    schema: () => ({ type: "array", items: ACCOUNT }),
    example: constant(["<user id>"]),
  },
  attachment: {
    schema: () => ({
      type: "array",
      items: {
        oneOf: [
          { type: "string", description: "Attachment key (write)" },
          { $ref: "#/components/schemas/Attachment" },
        ],
      },
    }),
    example: constant(["<attachment key>"]),
  },
  relation_one_to_many: LINKS,
  relation_many_to_many: LINKS,
  formula: { schema: byKind },
  lookup: { schema: byKind },
  rollup: { schema: byKind },
  created_time: { schema: () => INSTANT },
  last_modified_time: { schema: () => INSTANT },
  created_by: { schema: () => ACCOUNT },
  last_modified_by: { schema: () => ACCOUNT },
  autonumber: { schema: () => NUMBER },
  // AnyGridDB's uuid, or a client table's key as text.
  row_id: { schema: () => STRING },
  button: { schema: byKind },
} satisfies Record<FieldType, ApiValue>;

/** Whether a client writes the field: a value of its own, or links. */
export function takesApiWrites(fieldType: FieldType): boolean {
  return isWritableType(fieldType) || isRelationType(fieldType);
}

/** A type no definition names is described by what it reads as. */
function valueOf(fieldType: FieldType): ApiValue {
  return Object.hasOwn(API_VALUES, fieldType)
    ? API_VALUES[fieldType]
    : { schema: byKind };
}

/** The field's value in OpenAPI terms, before its description. */
export function apiValueSchema(field: ApiField): JsonSchema {
  return valueOf(field.fieldType).schema(field);
}

/** What a client must know to write the field, beyond its schema. */
export function apiValueNote(fieldType: FieldType): string | undefined {
  return valueOf(fieldType).note;
}

/** A value a client writes in the field; none for a field nobody writes. */
export function apiValueExample(field: ApiField, text: string): unknown {
  return valueOf(field.fieldType).example?.(field, text);
}
