import type { FieldType } from "@anygriddb/core";
import { isLinkArray } from "../../lib/format";

/**
 * How a cell is drawn: ticked or not; options as badges; stars; people;
 * files; linked rows; a web address or a mail address as a link; a colour
 * with its swatch; a place with its pin; a document in a fixed font; an id
 * in a fixed font; or its text.
 */
export type Drawing =
  | "checkbox"
  | "options"
  | "stars"
  | "people"
  | "files"
  | "links"
  | "address"
  | "mail"
  | "swatch"
  | "place"
  | "document"
  | "id"
  | "text";

/**
 * One entry per type: `satisfies Record<FieldType, …>` refuses a gap. A
 * computed field draws by the value it holds (`drawingOf`).
 */
const FIELD_DRAWING = {
  text: "text",
  long_text: "text",
  number: "text",
  boolean: "checkbox",
  date: "text",
  datetime: "text",
  single_select: "options",
  multi_select: "options",
  email: "mail",
  url: "address",
  phone: "text",
  color: "swatch",
  place: "place",
  json: "document",
  rating: "stars",
  duration: "text",
  user: "people",
  attachment: "files",
  relation_one_to_many: "links",
  relation_many_to_many: "links",
  formula: "text",
  lookup: "text",
  rollup: "text",
  created_time: "text",
  last_modified_time: "text",
  created_by: "people",
  last_modified_by: "people",
  autonumber: "text",
  row_id: "id",
  button: "text",
} as const satisfies Record<FieldType, Drawing>;

/**
 * How this value of this field is drawn: its type's drawing when the value
 * is one it can draw, else as any field draws such a value (a boolean
 * ticked, rows linked) or as its text.
 */
export function drawingOf(
  column: { fieldType: string; kind?: string },
  value: unknown,
): Drawing {
  const drawn: Drawing = Object.hasOwn(FIELD_DRAWING, column.fieldType)
    ? FIELD_DRAWING[column.fieldType as FieldType]
    : "text";
  if (
    drawn === "checkbox" ||
    (column.kind === "boolean" && typeof value === "boolean")
  ) {
    return "checkbox";
  }
  if (drawn === "options" || drawn === "people" || drawn === "files") {
    return drawn;
  }
  if (drawn === "stars" && typeof value === "number") return "stars";
  if (isLinkArray(value)) return "links";
  if (typeof value !== "string") return drawn === "id" ? "id" : "text";
  switch (drawn) {
    case "address":
    case "mail":
    case "swatch":
    case "place":
    case "document":
    case "id":
      return drawn;
    default:
      return "text";
  }
}
