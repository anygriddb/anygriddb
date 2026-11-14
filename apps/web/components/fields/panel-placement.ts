/** A box on screen, as `getBoundingClientRect` gives it. */
type Box = {
  top: number;
  right: number;
  bottom: number;
  left: number;
};

export type Placement = {
  /** `start`: the panel's left edge on the cell's; `end`: right on right. */
  x: "start" | "end";
  /** `below`: the panel's top on the cell's; `above`: bottom on bottom. */
  y: "below" | "above";
};

/**
 * Where a cell's panel opens so that it stays on screen: from the cell's
 * top left corner, as it always did, unless it would leave what can be seen
 * on that side and fits on the other.
 */
export function panelPlacement(
  cell: Box,
  size: { width: number; height: number },
  visible: Box,
): Placement {
  const overflowsRight = cell.left + size.width > visible.right;
  const fitsLeft = cell.right - size.width >= visible.left;
  const overflowsBottom = cell.top + size.height > visible.bottom;
  const fitsAbove = cell.bottom - size.height >= visible.top;
  return {
    x: overflowsRight && fitsLeft ? "end" : "start",
    y: overflowsBottom && fitsAbove ? "above" : "below",
  };
}

/** What of an element can be seen: the window, cut by every scrolling box. */
export function visibleBox(element: Element): Box {
  const box: Box = {
    top: 0,
    left: 0,
    right: window.innerWidth,
    bottom: window.innerHeight,
  };
  for (
    let parent = element.parentElement;
    parent;
    parent = parent.parentElement
  ) {
    const style = getComputedStyle(parent);
    if (style.overflowX === "visible" && style.overflowY === "visible") {
      continue;
    }
    const clip = parent.getBoundingClientRect();
    box.top = Math.max(box.top, clip.top);
    box.left = Math.max(box.left, clip.left);
    box.right = Math.min(box.right, clip.right);
    box.bottom = Math.min(box.bottom, clip.bottom);
  }
  return box;
}
