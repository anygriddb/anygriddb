import { AppError } from "./errors";
/**
 * Field type registry: which types own a physical column, which are
 * computed, which read a system column, and the SQL type behind each one.
 */
export const FIELD_TYPES = [
  "text",
  "long_text",
  "number",
  "boolean",
  "date",
  "datetime",
  "single_select",
  "multi_select",
  "email",
  "url",
  "phone",
  "rating",
  "duration",
  "user",
  "attachment",
  "relation_one_to_many",
  "relation_many_to_many",
  "formula",
  "lookup",
  "rollup",
  "created_time",
  "last_modified_time",
  "created_by",
  "last_modified_by",
  "autonumber",
  "button",
] as const;

export type FieldType = (typeof FIELD_TYPES)[number];

/** Types a user writes through row values. Links go through `setLinks`. */
export const WRITABLE_TYPES = [
  "text",
  "long_text",
  "number",
  "boolean",
  "date",
  "datetime",
  "single_select",
  "multi_select",
  "email",
  "url",
  "phone",
  "rating",
  "duration",
  "user",
  "attachment",
] as const;

export type WritableType = (typeof WRITABLE_TYPES)[number];

export const SYSTEM_TYPES = [
  "created_time",
  "last_modified_time",
  "created_by",
  "last_modified_by",
  "autonumber",
] as const;

export type SystemType = (typeof SYSTEM_TYPES)[number];

export const COMPUTED_TYPES = ["formula", "lookup", "rollup"] as const;

export type ComputedType = (typeof COMPUTED_TYPES)[number];

export const SYSTEM_COLUMN: Record<SystemType, string> = {
  created_time: "ag_created_at",
  last_modified_time: "ag_updated_at",
  created_by: "ag_created_by",
  last_modified_by: "ag_updated_by",
  autonumber: "ag_seq",
};

/** Names a user column can never take: row identity and system columns. */
export const RESERVED_COLUMN_NAMES: ReadonlySet<string> = new Set([
  "id",
  "ag_status",
  "ag_seq",
  "ag_position",
  "ag_created_at",
  "ag_updated_at",
  "ag_created_by",
  "ag_updated_by",
]);

const SQL_TYPE: Record<WritableType, string> = {
  text: "text",
  long_text: "text",
  email: "text",
  url: "text",
  phone: "text",
  single_select: "text",
  number: "numeric",
  rating: "numeric",
  duration: "numeric",
  boolean: "boolean",
  date: "date",
  datetime: "timestamptz",
  multi_select: "text[]",
  user: "uuid[]",
  attachment: "text[]",
};

/**
 * The kind of value a column yields, which decides filter operators,
 * sorting, formula typing, and how a cell is rendered.
 */
export type ValueKind =
  | "text"
  | "number"
  | "boolean"
  | "date"
  | "datetime"
  | "options"
  | "users"
  | "user"
  | "files"
  | "links";

const VALUE_KIND: Record<Exclude<FieldType, ComputedType>, ValueKind> = {
  text: "text",
  long_text: "text",
  email: "text",
  url: "text",
  phone: "text",
  single_select: "text",
  number: "number",
  rating: "number",
  duration: "number",
  boolean: "boolean",
  date: "date",
  datetime: "datetime",
  multi_select: "options",
  user: "users",
  attachment: "files",
  relation_one_to_many: "links",
  relation_many_to_many: "links",
  created_time: "datetime",
  last_modified_time: "datetime",
  created_by: "user",
  last_modified_by: "user",
  autonumber: "number",
  button: "text",
};

/**
 * Types that may be a table's primary field (row label for links, panels,
 * and card titles). Must coerce cleanly through `asText` / `labelSql`.
 */
export const PRIMARY_TYPES: ReadonlySet<FieldType> = new Set([
  "text",
  "long_text",
  "email",
  "url",
  "phone",
  "number",
  "date",
  "datetime",
  "single_select",
  "formula",
  "autonumber",
]);

export function isPrimaryType(fieldType: FieldType): boolean {
  return PRIMARY_TYPES.has(fieldType);
}

export function isWritableType(
  fieldType: FieldType,
): fieldType is WritableType {
  return (WRITABLE_TYPES as readonly string[]).includes(fieldType);
}

/**
 * Types a field may require a value in: a value typed or chosen when the
 * row is written. A checkbox is never empty; people and files are added to
 * a row once it exists.
 */
export function canBeRequired(fieldType: FieldType): boolean {
  return (
    isWritableType(fieldType) &&
    fieldType !== "boolean" &&
    fieldType !== "user" &&
    fieldType !== "attachment"
  );
}

export function isSystemType(fieldType: FieldType): fieldType is SystemType {
  return (SYSTEM_TYPES as readonly string[]).includes(fieldType);
}

export function isComputedType(
  fieldType: FieldType,
): fieldType is ComputedType {
  return (COMPUTED_TYPES as readonly string[]).includes(fieldType);
}

export function isRelationType(
  fieldType: FieldType,
): fieldType is "relation_one_to_many" | "relation_many_to_many" {
  return (
    fieldType === "relation_one_to_many" ||
    fieldType === "relation_many_to_many"
  );
}

/** True when the column owns a physical column of its own name. */
export function hasPhysicalColumn(fieldType: FieldType): boolean {
  return isWritableType(fieldType) || fieldType === "relation_one_to_many";
}

export function physicalSqlType(fieldType: FieldType): string {
  if (isWritableType(fieldType)) {
    return SQL_TYPE[fieldType];
  }
  if (fieldType === "relation_one_to_many") {
    return "uuid";
  }
  throw new AppError("invalid_column");
}

/** Value kind for every type except computed ones, which are typed later. */
export function storedValueKind(
  fieldType: Exclude<FieldType, ComputedType>,
): ValueKind {
  return VALUE_KIND[fieldType];
}

export function isArrayKind(kind: ValueKind): boolean {
  return (
    kind === "options" ||
    kind === "users" ||
    kind === "files" ||
    kind === "links"
  );
}
