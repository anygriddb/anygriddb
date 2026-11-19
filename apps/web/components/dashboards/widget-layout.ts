/** A widget's place on a dashboard's grid of 12 columns. */
export type PlacedWidget = {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
};

const COLUMNS = 12;

function overlaps(a: PlacedWidget, b: PlacedWidget): boolean {
  return (
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
  );
}

/**
 * The widgets laid out again in `order`, each at the first place where it
 * fits after the one before it, reading by row then by column: their
 * sizes kept, none over another, and read in the order given.
 */
export function packWidgets<T extends PlacedWidget>(order: readonly T[]): T[] {
  const placed: T[] = [];
  let from = { x: 0, y: 0 };
  for (const widget of order) {
    const w = Math.min(Math.max(widget.w, 1), COLUMNS);
    let spot: T | undefined;
    for (let y = from.y; !spot; y += 1) {
      for (let x = y === from.y ? from.x : 0; x + w <= COLUMNS; x += 1) {
        const candidate = { ...widget, x, y, w };
        if (!placed.some((other) => overlaps(candidate, other))) {
          spot = candidate;
          break;
        }
      }
    }
    placed.push(spot);
    from = { x: spot.x + spot.w, y: spot.y };
  }
  return placed;
}

/**
 * Where a widget stands on the page's grid: at its place among the twelve
 * columns, or, on a screen too narrow for them, across the whole width,
 * under the widget read before it and as tall as it is. On a phone a
 * widget three columns wide was a quarter of the screen.
 */
export function widgetCell(
  widget: PlacedWidget,
  stacked: boolean,
): { gridColumn: string; gridRow: string } {
  return stacked
    ? { gridColumn: "1 / -1", gridRow: `span ${String(widget.h)}` }
    : {
        gridColumn: `${String(widget.x + 1)} / span ${String(widget.w)}`,
        gridRow: `${String(widget.y + 1)} / span ${String(widget.h)}`,
      };
}

/** The widgets in reading order: by row, then by column. */
export function readingOrder<T extends PlacedWidget>(
  widgets: readonly T[],
): T[] {
  return [...widgets].sort((a, b) => a.y - b.y || a.x - b.x);
}

/**
 * The layout with one widget a place earlier or later in reading order,
 * the others packed around it; null when it is already first or last.
 */
export function moveWidget<T extends PlacedWidget>(
  widgets: readonly T[],
  id: string,
  by: -1 | 1,
): T[] | null {
  const order = readingOrder(widgets);
  const at = order.findIndex((widget) => widget.id === id);
  if (at < 0) return null;
  return placeWidget(widgets, id, at + by);
}

/**
 * The layout with one widget moved to `index` in reading order, the
 * place it takes, the others packed around it. Null when the index is
 * outside the list, the widget is already there, or it is unknown.
 */
export function placeWidget<T extends PlacedWidget>(
  widgets: readonly T[],
  id: string,
  index: number,
): T[] | null {
  const order = readingOrder(widgets);
  const from = order.findIndex((widget) => widget.id === id);
  const moved = order[from];
  if (
    from < 0 ||
    !moved ||
    index < 0 ||
    index >= order.length ||
    from === index
  ) {
    return null;
  }
  const rest = order.filter((widget) => widget.id !== id);
  rest.splice(index, 0, moved);
  return packWidgets(rest);
}
