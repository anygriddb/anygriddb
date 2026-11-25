import { cellText, prettyJson, type FieldType } from "@anygriddb/core";
import { editableNumber } from "../../lib/cell-reading";

/** A value typed into an input of one line, or of many. */
export type Typing = {
  by: "typing";
  /** The input's type: a phone's keyboard follows it. */
  input: "text" | "email" | "url" | "tel";
  /** A phone's keyboard of digits and a decimal mark. */
  digits?: true;
  /** Lines of its own: Enter starts a new one, Ctrl+Enter ends the edit. */
  lines?: "many";
  /** A document: a fixed-width font, never spell-checked. */
  code?: true;
  /** A colour, typed or picked beside what is typed. */
  swatch?: true;
  /** How the value held is written to be edited, when not as its text. */
  shownAs?: "number" | "duration" | "document";
};

/**
 * How a person gives a field of each type its value, wherever it is
 * edited: a grid's cell, a row's panel, a form, a new row. Typed in an
 * input; picked on a calendar, among stars, options, people, rows or
 * files; ticked; or not given at all, by a field that is computed, kept by
 * the system, or a button.
 */
export type Editing =
  | Typing
  | { by: "date"; time?: true }
  | { by: "rating" }
  | { by: "options"; multiple?: true }
  | { by: "people" }
  | { by: "links" }
  | { by: "files" }
  | { by: "checkbox" }
  | { by: "button" }
  | { by: "none" };

const NONE: Editing = { by: "none" };

/** One entry per type: `satisfies Record<FieldType, …>` refuses a gap. */
const FIELD_EDITING = {
  text: { by: "typing", input: "text" },
  long_text: { by: "typing", input: "text", lines: "many" },
  number: { by: "typing", input: "text", digits: true, shownAs: "number" },
  boolean: { by: "checkbox" },
  date: { by: "date" },
  datetime: { by: "date", time: true },
  single_select: { by: "options" },
  multi_select: { by: "options", multiple: true },
  email: { by: "typing", input: "email" },
  url: { by: "typing", input: "url" },
  phone: { by: "typing", input: "tel" },
  color: { by: "typing", input: "text", swatch: true },
  place: { by: "typing", input: "text" },
  json: {
    by: "typing",
    input: "text",
    lines: "many",
    code: true,
    shownAs: "document",
  },
  rating: { by: "rating" },
  // Typed as hours and minutes: a keyboard of digits has no colon.
  duration: { by: "typing", input: "text", shownAs: "duration" },
  user: { by: "people" },
  attachment: { by: "files" },
  relation_one_to_many: { by: "links" },
  relation_many_to_many: { by: "links" },
  formula: NONE,
  lookup: NONE,
  rollup: NONE,
  created_time: NONE,
  last_modified_time: NONE,
  created_by: NONE,
  last_modified_by: NONE,
  autonumber: NONE,
  row_id: NONE,
  button: { by: "button" },
} satisfies Record<FieldType, Editing>;

/** How a field of this type is edited; a type unknown here is not. */
export function editingOf(fieldType: string): Editing {
  return Object.hasOwn(FIELD_EDITING, fieldType)
    ? FIELD_EDITING[fieldType as FieldType]
    : NONE;
}

/**
 * Whether the field is edited in a panel of choices (options, people,
 * rows, files): a key typed on its cell opens the panel and is not
 * written into it.
 */
export function opensPanel(fieldType: string): boolean {
  const { by } = editingOf(fieldType);
  return (
    by === "options" || by === "people" || by === "links" || by === "files"
  );
}

/** Whether the field is typed on lines of its own. */
export function takesLines(fieldType: string): boolean {
  const editing = editingOf(fieldType);
  return editing.by === "typing" && editing.lines === "many";
}

/**
 * What an answer of a form or a new row holds before anything is given:
 * no option of a list, a checkbox not ticked, an empty text.
 */
export function blankAnswer(fieldType: string): string | string[] | boolean {
  const editing = editingOf(fieldType);
  if (editing.by === "options" && editing.multiple) return [];
  return editing.by === "checkbox" ? false : "";
}

const two = (value: number) => String(value).padStart(2, "0");

/**
 * A duration as hours and minutes, and its seconds when it has any (to
 * the millisecond), whatever the field shows: what is edited is the whole
 * value, as a spreadsheet's formula bar writes it.
 */
export function durationText(seconds: number): string {
  const total = Math.round(seconds * 1000);
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const rest = total % 60_000;
  const clock = `${hours}:${two(minutes)}`;
  if (rest === 0) return clock;
  // `0.5` for 500 milliseconds: the digits after the point, no zero after.
  const fraction = String((rest % 1000) / 1000).slice(2);
  const whole = `${clock}:${two(Math.floor(rest / 1000))}`;
  return fraction === "" ? whole : `${whole}.${fraction}`;
}

/** The text an input holds when it opens on a value the field already has. */
export function editableText(
  value: unknown,
  fieldType: string,
  locale: "fr" | "en",
): string {
  if (value === null || value === undefined) return "";
  const editing = editingOf(fieldType);
  const shownAs = editing.by === "typing" ? editing.shownAs : undefined;
  // Read back in the same language: `1.234` is written `1,234` in French.
  if (shownAs === "number") return editableNumber(cellText(value), locale);
  if (shownAs === "duration" && typeof value === "number") {
    return durationText(value);
  }
  // A document is edited laid out, a member a line.
  if (shownAs === "document") return prettyJson(cellText(value));
  return cellText(value);
}
