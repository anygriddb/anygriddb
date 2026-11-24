/**
 * A form's answers, read as its fields write them, every one: each answer
 * missing or refused is said beside its field, not the first one alone at
 * the foot of the form. The public form, the form view, and the dialog of a
 * new row read theirs here.
 */
import { readCellValue, type CellRefusal } from "@anygriddb/core";
import { readingGiven, type Reading } from "../../lib/cell-reading";
import { dateFormatOf, editZone, formInstant } from "../../lib/dates";
import type { CatalogColumn } from "../../lib/types";

/** What a field of a form holds while it is filled. */
export type FormAnswer = string | string[] | boolean;

/** What is wrong with one answer, by its field. */
export type AnswerProblem = {
  column: string;
  label: string;
} & (
  { kind: "required" } | { kind: "refused"; refused: CellRefusal | undefined }
);

export function readFormAnswers(
  fields: ReadonlyArray<{
    column: CatalogColumn;
    label: string;
    required: boolean;
  }>,
  values: Readonly<Record<string, FormAnswer | undefined>>,
  options: {
    /** What the person typed is read with this. */
    reading: Reading;
    /** Answers a link or the page gave: not in the reader's language. */
    given?: Readonly<Record<string, unknown>>;
    /** A link to one row, whose answer is that row's id as it is. */
    oneRow?: (column: CatalogColumn) => boolean;
  },
): { values: Record<string, unknown>; problems: AnswerProblem[] } {
  const out: Record<string, unknown> = {};
  const problems: AnswerProblem[] = [];
  for (const { column, label, required } of fields) {
    const raw = values[column.name];
    if (
      raw === undefined ||
      raw === "" ||
      (Array.isArray(raw) && raw.length === 0)
    ) {
      if (required)
        problems.push({ column: column.name, label, kind: "required" });
      continue;
    }
    if (options.oneRow?.(column)) {
      out[column.name] = [raw as string];
      continue;
    }
    const reading =
      column.fieldType === "datetime" && typeof raw === "string"
        ? { value: formInstant(raw, editZone(dateFormatOf(column))) }
        : readCellValue(
            { fieldType: column.fieldType, config: column.config },
            raw,
            raw === options.given?.[column.name]
              ? readingGiven()
              : options.reading,
          );
    if ("refused" in reading || reading.value === undefined) {
      problems.push({
        column: column.name,
        label,
        kind: "refused",
        refused: "refused" in reading ? reading.refused : undefined,
      });
      continue;
    }
    out[column.name] = reading.value;
  }
  return { values: out, problems };
}
