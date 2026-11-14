import {
  coerceCellValue,
  isEmail,
  isHttpUrl,
  isIsoDateTime,
} from "./cell-values";
import { OPTION_COLORS, type SelectOption } from "./field-config";
import type { WritableType } from "./field-types";

export type InferredField = {
  fieldType: WritableType;
  options?: SelectOption[];
};

const SAMPLE = 2_000;
/** The options a single select is guessed with, at most. */
const SELECT_OPTIONS = 25;

const PLAIN = { config: {} };

/**
 * A field type guessed from text values seen one at a time, as many as
 * come: the same guess as `inferFieldType` makes of them all, holding
 * only what each candidate type still needs. Empty cells are ignored.
 */
export class FieldGuess {
  private seen = 0;
  private boolean = true;
  private number = true;
  private datetime = true;
  private date = true;
  private email = true;
  private url = true;
  private long = false;
  private short = true;
  private many = false;
  private readonly lowered = new Set<string>();
  private readonly distinct = new Set<string>();

  add(raw: string): void {
    const value = raw.trim();
    if (value === "") return;
    this.seen += 1;
    if (this.boolean) {
      if (
        coerceCellValue({ fieldType: "boolean", ...PLAIN }, value) === undefined
      ) {
        this.boolean = false;
      } else if (this.lowered.size <= 4) {
        this.lowered.add(value.toLowerCase());
      }
    }
    if (
      this.number &&
      coerceCellValue({ fieldType: "number", ...PLAIN }, value) === undefined
    ) {
      this.number = false;
    }
    if (
      this.datetime &&
      !(
        isIsoDateTime(value) && !/T00:00(:00)?(\.0+)?(Z|[+-]00:00)$/.test(value)
      )
    ) {
      this.datetime = false;
    }
    if (
      this.date &&
      coerceCellValue({ fieldType: "date", ...PLAIN }, value) === undefined
    ) {
      this.date = false;
    }
    if (this.email && !isEmail(value)) this.email = false;
    if (this.url && !isHttpUrl(value)) this.url = false;
    if (value.length > 255 || value.includes("\n")) this.long = true;
    if (value.length > 40) this.short = false;
    if (!this.many) {
      this.distinct.add(value);
      if (this.distinct.size > SELECT_OPTIONS) this.many = true;
    }
  }

  /**
   * The guess so far. A short list of repeated values becomes a single
   * select with options.
   */
  result(): InferredField {
    if (this.seen === 0) return { fieldType: "text" };
    if (this.boolean && this.lowered.size <= 4) return { fieldType: "boolean" };
    if (this.number) return { fieldType: "number" };
    if (this.datetime) return { fieldType: "datetime" };
    if (this.date) return { fieldType: "date" };
    if (this.email) return { fieldType: "email" };
    if (this.url) return { fieldType: "url" };
    if (this.long) return { fieldType: "long_text" };
    const repeated =
      this.seen >= 5 &&
      !this.many &&
      this.distinct.size <= Math.min(SELECT_OPTIONS, Math.floor(this.seen / 2));
    if (repeated && this.short) {
      return {
        fieldType: "single_select",
        options: [...this.distinct].map((name, index) => ({
          name: name.slice(0, 80),
          color: OPTION_COLORS[index % OPTION_COLORS.length] ?? "gray",
        })),
      };
    }
    return { fieldType: "text" };
  }
}

/**
 * Guesses a field type from imported text values, the first 2,000 of
 * them. Empty cells are ignored. A short list of repeated values becomes
 * a single select with options.
 */
export function inferFieldType(raw: readonly string[]): InferredField {
  const guess = new FieldGuess();
  for (const value of raw.slice(0, SAMPLE)) guess.add(value);
  return guess.result();
}
