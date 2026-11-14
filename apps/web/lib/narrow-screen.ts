import { useSyncExternalStore } from "react";

/** Under this width the navigation folds away: a phone, a narrow window. */
const NARROW_SCREEN = "(max-width: 767px)";

/**
 * Where the navigation stands: beside the page on a wide screen; on a
 * narrow one, folded away, or open over the page.
 */
export type NavigationMode = "docked" | "closed" | "open";

/**
 * The navigation is open only on the page it was opened on, so going to
 * another page closes it, and a wide screen never has it open or closed.
 */
export function navigationMode(
  narrow: boolean,
  openedOn: string | null,
  page: string,
): NavigationMode {
  if (!narrow) return "docked";
  return openedOn === page ? "open" : "closed";
}

function subscribe(onChange: () => void): () => void {
  const media = window.matchMedia(NARROW_SCREEN);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

/** Whether the window is narrow now; follows the window as it changes. */
export function useNarrowScreen(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(NARROW_SCREEN).matches,
    () => false,
  );
}
