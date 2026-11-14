/**
 * Leaving a widget that keeps Tab for itself (the grid): the control the
 * keyboard reaches next outside it, as Tab would reach it were the widget
 * one stop, whatever controls it holds.
 */

/** Where a control stands to the widget, in the page's order. */
export type Place = "before" | "inside" | "after";

/**
 * The control to reach: the first after the widget, or the last before
 * it going back; past the page's end, round to its other end, as Tab
 * goes round a page.
 */
export function pickOutside<T>(
  controls: readonly T[],
  placeOf: (control: T) => Place,
  backward: boolean,
): T | undefined {
  const outside = controls.filter((item) => placeOf(item) !== "inside");
  if (backward) {
    return (
      outside.findLast((item) => placeOf(item) === "before") ?? outside.at(-1)
    );
  }
  return outside.find((item) => placeOf(item) === "after") ?? outside[0];
}

const TABBABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]",
  "[contenteditable='true']",
].join(",");

function reachable(element: HTMLElement): boolean {
  return (
    element.tabIndex >= 0 &&
    element.closest("[inert]") === null &&
    element.getClientRects().length > 0
  );
}

/**
 * Moves the focus out of `widget`, forward or back. Says false when the
 * page has no other control, or when the one picked would not take the
 * focus (it is drawn but hidden), for the browser to move it itself.
 */
export function focusOutside(widget: HTMLElement, backward: boolean): boolean {
  const controls = [
    ...widget.ownerDocument.querySelectorAll<HTMLElement>(TABBABLE),
  ].filter(reachable);
  const target = pickOutside(
    controls,
    (control) =>
      widget.contains(control)
        ? "inside"
        : widget.compareDocumentPosition(control) &
            Node.DOCUMENT_POSITION_FOLLOWING
          ? "after"
          : "before",
    backward,
  );
  if (!target) return false;
  target.focus();
  return widget.ownerDocument.activeElement === target;
}
