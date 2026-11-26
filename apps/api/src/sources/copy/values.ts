/**
 * What every store without SQL shares (ADR 0088): how a row is named, which
 * of its fields a copy can keep, and what a field's values make it.
 */
import { createHash } from "node:crypto";
import { compareCodeUnits, type MappedField, ceilingOf } from "@anygriddb/core";

/** A row id is a text of this many characters at most. */
const ID_MAX = ceilingOf("copy.id_chars");

/**
 * The id of a row from the values of its key: the value itself for one
 * field, a JSON array for several, as a client's SQL table names its rows.
 * A key too long to be an id, or an empty one, is named by its digest.
 */
export function rowId(key: ReadonlyArray<string | number | boolean>): string {
  const [first] = key;
  const text =
    key.length === 1 && first !== undefined
      ? String(first)
      : JSON.stringify(key);
  return text.length > 0 && text.length <= ID_MAX ? text : digestId(text);
}

/** The id of a row that has no key: its content, so the same row keeps it. */
export function contentId(row: Readonly<Record<string, unknown>>): string {
  const names = Object.keys(row).sort(compareCodeUnits);
  return digestId(JSON.stringify(names.map((name) => [name, row[name]])));
}

function digestId(text: string): string {
  return `~${createHash("sha256").update(text).digest("hex")}`;
}

/**
 * Whether a copy can keep a field under the name its store gives it: a
 * PostgreSQL column takes 63 bytes, no control character, and `ag_id` is
 * the copy's own.
 */
export function isCopyableName(name: string): boolean {
  return (
    name.length > 0 &&
    name !== "ag_id" &&
    Buffer.byteLength(name, "utf8") <= 63 &&
    !/\p{Cc}/u.test(name)
  );
}

/** What one value is, among the kinds a store's values come in. */
export type ValueKind =
  "text" | "integer" | "number" | "boolean" | "datetime" | "date" | "document";

/** Longer than this, or on several lines, a text is a long one. */
const SHORT_TEXT = 255;

/**
 * Tells a field's type from the values it holds in the rows sampled: one
 * kind makes the field of that kind; whole numbers among others stay
 * numbers; anything else mixed reads as text, each value as it is written.
 */
export class FieldSample {
  private readonly kinds = new Set<ValueKind>();
  private readonly natives = new Set<string>();
  private long = false;

  /** One value: its kind, its type as the store names it, a text itself. */
  add(kind: ValueKind, native: string, text?: string): void {
    this.kinds.add(kind);
    this.natives.add(native);
    if (
      kind === "text" &&
      text !== undefined &&
      (text.length > SHORT_TEXT || text.includes("\n"))
    ) {
      this.long = true;
    }
  }

  /** The field, and the name of its type as the source's page shows it. */
  describe(): { type: string; field: MappedField } {
    const kinds = [...this.kinds];
    const [kind] = kinds;
    const [native] = [...this.natives];
    if (kind === undefined || native === undefined) {
      // Empty in every row sampled: a text until a value says otherwise.
      return { type: "null", field: fieldOf("text", false) };
    }
    if (kinds.length === 1) {
      return {
        type:
          this.natives.size === 1
            ? native
            : kind === "integer" || kind === "number"
              ? WIDEST[kind]
              : "mixed",
        field: fieldOf(kind, this.long),
      };
    }
    if (kinds.every((item) => NUMBERS.has(item))) {
      return { type: WIDEST.number, field: fieldOf("number", false) };
    }
    return {
      type: "mixed",
      field: fieldOf("text", this.long || kinds.includes("document")),
    };
  }
}

/** The type that holds every number of a kind, as its field's format reads it. */
const WIDEST: Record<"integer" | "number", string> = {
  integer: "bigint",
  number: "double",
};

const NUMBERS = new Set<ValueKind>(["integer", "number"]);

function fieldOf(kind: ValueKind, long: boolean): MappedField {
  switch (kind) {
    case "integer":
    case "number":
      return { fieldType: "number", readOnly: false };
    case "boolean":
      return { fieldType: "boolean", readOnly: false };
    case "datetime":
      return { fieldType: "datetime", readOnly: false };
    case "date":
      return { fieldType: "date", readOnly: false };
    case "document":
      return { fieldType: "json", readOnly: false };
    case "text":
      return { fieldType: long ? "long_text" : "text", readOnly: false };
  }
}
