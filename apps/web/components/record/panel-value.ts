import { type BooleanAppearance, isBlankCell } from "@anygriddb/core";

/**
 * How a row's panel draws a field's value:
 *
 * - `blank`: the field holds nothing, and the panel says so;
 * - `unticked`: a checkbox drawn as a box, and not ticked: an empty box;
 * - `value`: the value's own drawing.
 */
type PanelDrawing =
  { kind: "blank" } | { kind: "unticked" } | { kind: "value"; value: unknown };

/**
 * What the panel draws for a field. A checkbox never ticked is drawn as
 * not ticked, and a rating never given as none of its stars: a grid
 * leaves both cells empty, but the panel names every field, and a line
 * that showed nothing under "Done" said nothing of what a click does.
 */
export function panelDrawing(input: {
  fieldType: string;
  /** How a checkbox is drawn; null for any other field. */
  appearance: BooleanAppearance | null;
  value: unknown;
  /** The value is an error: it is drawn as one, never as empty. */
  failed: boolean;
}): PanelDrawing {
  if (input.failed) return { kind: "value", value: input.value };
  if (input.fieldType === "boolean") {
    const ticked = input.value === true;
    return !ticked && input.appearance === "check"
      ? { kind: "unticked" }
      : { kind: "value", value: ticked };
  }
  if (input.fieldType === "rating") {
    return {
      kind: "value",
      value: typeof input.value === "number" ? input.value : 0,
    };
  }
  return isBlankCell(input.value)
    ? { kind: "blank" }
    : { kind: "value", value: input.value };
}
