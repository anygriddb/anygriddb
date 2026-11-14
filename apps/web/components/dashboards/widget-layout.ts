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
  const moved = order[at];
  const other = order[at + by];
  if (at < 0 || !moved || !other) return null;
  order[at] = other;
  order[at + by] = moved;
  return packWidgets(order);
}
