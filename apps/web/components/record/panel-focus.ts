import { useEffect, useRef, type RefObject } from "react";

/** Where the keyboard is, as the row's panel sees it. */
export type KeyboardPlace = "panel" | "page" | "nowhere";

/**
 * A row that opens takes the keyboard into its panel, unless the keyboard
 * is there already: the panel's own buttons walk from row to row.
 */
export function takesKeyboard(place: KeyboardPlace): boolean {
  return place !== "panel";
}

/**
 * A panel that closes gives the keyboard back to what opened it, when
 * closing left it nowhere and that element is still drawn. A person who
 * moved on to something else on the page keeps their place.
 */
export function givesKeyboardBack(
  place: KeyboardPlace,
  openerDrawn: boolean,
): boolean {
  return place === "nowhere" && openerDrawn;
}

function placeOf(panel: HTMLElement | null): KeyboardPlace {
  const active = document.activeElement;
  if (!active || active === document.body) return "nowhere";
  return panel?.contains(active) ? "panel" : "page";
}

/**
 * The row's panel, beside the page, as the keyboard meets it: it takes
 * the keyboard when a row opens in it, and gives it back to what opened
 * it (a card, a day, the grid) when it closes. Without this a card opened
 * from the keyboard left its row beyond every other card of the view.
 * Off where the panel covers the page: a dialog does this itself.
 */
export function usePanelFocus(
  rowId: string | undefined,
  beside: boolean,
): RefObject<HTMLElement | null> {
  const panel = useRef<HTMLElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const element = panel.current;
    if (!beside || !element || rowId === undefined) return;
    if (!takesKeyboard(placeOf(element))) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body) {
      opener.current = active;
    }
    element.focus();
  }, [rowId, beside]);
  useEffect(
    () => () => {
      const from = opener.current;
      if (from && givesKeyboardBack(placeOf(null), from.isConnected)) {
        from.focus();
      }
    },
    [],
  );
  return panel;
}
