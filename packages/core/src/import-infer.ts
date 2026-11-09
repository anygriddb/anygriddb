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

function every(
  values: readonly string[],
  test: (value: string) => boolean,
): boolean {
  return values.length > 0 && values.every(test);
}

/**
 * Guesses a field type from imported text values. Empty cells are ignored.
 * A short list of repeated values becomes a single select with options.
 */
export function inferFieldType(raw: readonly string[]): InferredField {
  const values = raw
    .slice(0, SAMPLE)
    .map((value) => value.trim())
    .filter((value) => value !== "");
  if (values.length === 0) {
    return { fieldType: "text" };
  }
  const plain = { config: {} };
  if (
    every(
      values,
      (value) =>
        coerceCellValue({ fieldType: "boolean", ...plain }, value) !==
        undefined,
    )
  ) {
    const lowered = new Set(values.map((value) => value.toLowerCase()));
    if (lowered.size <= 4) return { fieldType: "boolean" };
  }
  if (
    every(
      values,
      (value) =>
        coerceCellValue({ fieldType: "number", ...plain }, value) !== undefined,
    )
  ) {
    return { fieldType: "number" };
  }
  if (
    every(
      values,
      (value) =>
        isIsoDateTime(value) &&
        !/T00:00(:00)?(\.0+)?(Z|[+-]00:00)$/.test(value),
    )
  ) {
    return { fieldType: "datetime" };
  }
  if (
    every(
      values,
      (value) =>
        coerceCellValue({ fieldType: "date", ...plain }, value) !== undefined,
    )
  ) {
    return { fieldType: "date" };
  }
  if (every(values, isEmail)) return { fieldType: "email" };
  if (every(values, isHttpUrl)) return { fieldType: "url" };
  if (values.some((value) => value.length > 255 || value.includes("\n"))) {
    return { fieldType: "long_text" };
  }
  const distinct = [...new Set(values)];
  const repeated =
    values.length >= 5 &&
    distinct.length <= Math.min(25, Math.floor(values.length / 2));
  if (repeated && distinct.every((value) => value.length <= 40)) {
    return {
      fieldType: "single_select",
      options: distinct.slice(0, 200).map((name, index) => ({
        name: name.slice(0, 80),
        color: OPTION_COLORS[index % OPTION_COLORS.length] ?? "gray",
      })),
    };
  }
  return { fieldType: "text" };
}
