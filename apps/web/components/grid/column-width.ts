/** A header's padding, field icon, gaps, and menu button, in pixels. */
const HEADER_CHROME = 64;
/** A long name widens its column this far at most; past it, it truncates. */
const MAX_FROM_LABEL = 280;
const FALLBACK = 180;

/**
 * A column's width until someone sets one: its type's, or wider when its
 * name would not fit in the header otherwise.
 */
export function defaultColumnWidth(
  fieldType: string,
  labelWidth: number,
  byType: Readonly<Record<string, number>>,
): number {
  const typed = byType[fieldType] ?? FALLBACK;
  const fit = Math.min(MAX_FROM_LABEL, Math.ceil(labelWidth) + HEADER_CHROME);
  return Math.max(typed, fit);
}

/**
 * Measures a header's label as the header writes it (13 px, medium), once
 * per label. Without a canvas, an average letter's width stands in.
 */
export function createLabelMeasure(): (label: string) => number {
  const cache = new Map<string, number>();
  let context: CanvasRenderingContext2D | null | undefined;
  return (label) => {
    const known = cache.get(label);
    if (known !== undefined) return known;
    if (context === undefined) {
      context =
        typeof document === "undefined"
          ? null
          : document.createElement("canvas").getContext("2d");
      if (context) {
        context.font = `500 13px ${getComputedStyle(document.body).fontFamily}`;
      }
    }
    const width = context
      ? context.measureText(label).width
      : label.length * 7.5;
    cache.set(label, width);
    return width;
  };
}
