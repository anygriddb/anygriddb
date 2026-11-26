import { AppError } from "./errors";

/**
 * Field type registry: one definition per type owns its storage role, its
 * value kind, and what it may be (primary, required, kept beside a
 * client's table). The predicates below read it.
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
  "color",
  "place",
  "json",
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
  "row_id",
  "row_state",
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
  "color",
  "place",
  "json",
  "rating",
  "duration",
  "user",
  "attachment",
] as const;

export type WritableType = (typeof WRITABLE_TYPES)[number];

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

/**
 * How two values of a field are told apart, when a write is compared with
 * what its writer saw (ADR 0103): a text to the character, a document
 * whatever the order of its keys, an instant to the tenth of a microsecond,
 * a checkbox ticked or not, files by their keys, anything else as the value
 * it is.
 */
export type ComparedAs =
  "text" | "document" | "instant" | "checkbox" | "files" | "value";

type PhysicalRole =
  | { role: "writable"; sqlType: string }
  | { role: "relation_fk"; sqlType: "uuid" }
  | { role: "system"; column: string }
  | { role: "computed" }
  | { role: "virtual" }
  | { role: "relation_virtual" };

export type FieldTypeDefinition = {
  physical: PhysicalRole;
  /**
   * Filter/sort/rollup typing for stored columns. Computed types resolve
   * their kind when the expression is compiled.
   */
  storedValueKind: ValueKind | null;
  primaryEligible: boolean;
  requiredAllowed: boolean;
  /** Fields AnyGridDB may keep in a client's side table (ADR 0032). */
  sideEligible: boolean;
  comparedAs: ComparedAs;
};

function writable(
  sqlType: string,
  kind: ValueKind,
  comparedAs: ComparedAs,
  extras: Partial<
    Pick<
      FieldTypeDefinition,
      "primaryEligible" | "requiredAllowed" | "sideEligible"
    >
  > = {},
): FieldTypeDefinition {
  return {
    physical: { role: "writable", sqlType },
    storedValueKind: kind,
    primaryEligible: extras.primaryEligible ?? false,
    requiredAllowed: extras.requiredAllowed ?? true,
    sideEligible: extras.sideEligible ?? false,
    comparedAs,
  };
}

function system(column: string, kind: ValueKind): FieldTypeDefinition {
  return {
    physical: { role: "system", column },
    storedValueKind: kind,
    primaryEligible: column === "ag_seq" || column === "id",
    requiredAllowed: false,
    sideEligible: false,
    comparedAs: "value",
  };
}

/**
 * One definition per FieldType. `satisfies Record<FieldType, …>` refuses a
 * missing type; a new property on `FieldTypeDefinition` forces every type
 * to fill it in.
 */
export const FIELD_DEFINITIONS = {
  text: writable("text", "text", "text", {
    primaryEligible: true,
    sideEligible: true,
  }),
  long_text: writable("text", "text", "text", {
    primaryEligible: true,
    sideEligible: true,
  }),
  number: writable("numeric", "number", "value", {
    primaryEligible: true,
    sideEligible: true,
  }),
  boolean: writable("boolean", "boolean", "checkbox", {
    requiredAllowed: false,
    sideEligible: true,
  }),
  date: writable("date", "date", "instant", {
    primaryEligible: true,
    sideEligible: true,
  }),
  datetime: writable("timestamptz", "datetime", "instant", {
    primaryEligible: true,
    sideEligible: true,
  }),
  single_select: writable("text", "text", "text", {
    primaryEligible: true,
    sideEligible: true,
  }),
  multi_select: writable("text[]", "options", "value"),
  email: writable("text", "text", "text", {
    primaryEligible: true,
    sideEligible: true,
  }),
  url: writable("text", "text", "text", {
    primaryEligible: true,
    sideEligible: true,
  }),
  phone: writable("text", "text", "text", {
    primaryEligible: true,
    sideEligible: true,
  }),
  color: writable("text", "text", "text", { sideEligible: true }),
  place: writable("text", "text", "text", { sideEligible: true }),
  // Read as its text: a filter, a sort and a formula take it as one.
  json: writable("jsonb", "text", "document", { sideEligible: true }),
  rating: writable("numeric", "number", "value", { sideEligible: true }),
  duration: writable("numeric", "number", "value"),
  user: writable("uuid[]", "users", "value", { requiredAllowed: false }),
  attachment: writable("text[]", "files", "files", { requiredAllowed: false }),
  relation_one_to_many: {
    physical: { role: "relation_fk", sqlType: "uuid" },
    storedValueKind: "links",
    primaryEligible: false,
    requiredAllowed: false,
    sideEligible: false,
    comparedAs: "value",
  },
  relation_many_to_many: {
    physical: { role: "relation_virtual" },
    storedValueKind: "links",
    primaryEligible: false,
    requiredAllowed: false,
    sideEligible: false,
    comparedAs: "value",
  },
  formula: {
    physical: { role: "computed" },
    storedValueKind: null,
    primaryEligible: true,
    requiredAllowed: false,
    sideEligible: false,
    comparedAs: "value",
  },
  lookup: {
    physical: { role: "computed" },
    storedValueKind: null,
    primaryEligible: false,
    requiredAllowed: false,
    sideEligible: false,
    comparedAs: "value",
  },
  rollup: {
    physical: { role: "computed" },
    storedValueKind: null,
    primaryEligible: false,
    requiredAllowed: false,
    sideEligible: false,
    comparedAs: "value",
  },
  created_time: system("ag_created_at", "datetime"),
  last_modified_time: system("ag_updated_at", "datetime"),
  created_by: system("ag_created_by", "user"),
  last_modified_by: system("ag_updated_by", "user"),
  autonumber: system("ag_seq", "number"),
  // On a client's table, the row's key: `compileColumn` reads it from there.
  row_id: system("id", "text"),
  // The row's state in its table's circuit (ADR 0133): its key, which the
  // database guards; sorted in the circuit's order, shown by its label.
  row_state: system("ag_status", "text"),
  button: {
    physical: { role: "virtual" },
    storedValueKind: "text",
    primaryEligible: false,
    requiredAllowed: false,
    sideEligible: false,
    comparedAs: "value",
  },
} satisfies Record<FieldType, FieldTypeDefinition>;

type SystemType =
  | "created_time"
  | "last_modified_time"
  | "created_by"
  | "last_modified_by"
  | "autonumber"
  | "row_id"
  | "row_state";

type ComputedType = "formula" | "lookup" | "rollup";

export const SYSTEM_COLUMN: Record<SystemType, string> = {
  created_time: "ag_created_at",
  last_modified_time: "ag_updated_at",
  created_by: "ag_created_by",
  last_modified_by: "ag_updated_by",
  autonumber: "ag_seq",
  row_id: "id",
  row_state: "ag_status",
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

/**
 * Types that may be a table's primary field (row label for links, panels,
 * and card titles). Must coerce cleanly through `asText` / `labelSql`.
 */
export const PRIMARY_TYPES: ReadonlySet<FieldType> = new Set(
  FIELD_TYPES.filter((type) => FIELD_DEFINITIONS[type].primaryEligible),
);

function definitionOf(fieldType: string): FieldTypeDefinition | undefined {
  return Object.hasOwn(FIELD_DEFINITIONS, fieldType)
    ? FIELD_DEFINITIONS[fieldType as FieldType]
    : undefined;
}

/** How values of a field are compared as seen; any unknown type as values. */
export function comparedAs(fieldType: string | undefined): ComparedAs {
  return fieldType === undefined
    ? "value"
    : (definitionOf(fieldType)?.comparedAs ?? "value");
}

export function isPrimaryType(fieldType: FieldType): boolean {
  return definitionOf(fieldType)?.primaryEligible === true;
}

export function isWritableType(
  fieldType: FieldType,
): fieldType is WritableType {
  return definitionOf(fieldType)?.physical.role === "writable";
}

/**
 * Types a field may require a value in: a value typed or chosen when the
 * row is written. A checkbox is never empty; people and files are added to
 * a row once it exists.
 */
export function canBeRequired(fieldType: FieldType): boolean {
  return definitionOf(fieldType)?.requiredAllowed === true;
}

export function isSystemType(fieldType: FieldType): fieldType is SystemType {
  return definitionOf(fieldType)?.physical.role === "system";
}

export function isComputedType(
  fieldType: FieldType,
): fieldType is ComputedType {
  return definitionOf(fieldType)?.physical.role === "computed";
}

export function isRelationType(
  fieldType: FieldType,
): fieldType is "relation_one_to_many" | "relation_many_to_many" {
  const role = definitionOf(fieldType)?.physical.role;
  return role === "relation_fk" || role === "relation_virtual";
}

/** True when the column owns a physical column of its own name. */
export function hasPhysicalColumn(fieldType: FieldType): boolean {
  const role = definitionOf(fieldType)?.physical.role;
  return role === "writable" || role === "relation_fk";
}

export function physicalSqlType(fieldType: FieldType): string {
  const physical = definitionOf(fieldType)?.physical;
  if (physical?.role === "writable" || physical?.role === "relation_fk") {
    return physical.sqlType;
  }
  throw new AppError("invalid_column");
}

/** Value kind for every type except computed ones, which are typed later. */
export function storedValueKind(
  fieldType: Exclude<FieldType, ComputedType>,
): ValueKind {
  const kind = definitionOf(fieldType)?.storedValueKind;
  if (kind === null || kind === undefined) {
    throw new AppError("invalid_column");
  }
  return kind;
}
