/**
 * Whether the grid's tips were hidden in this browser, as the theme and
 * the language are kept: once hidden, they stay so on every table.
 */
const STORAGE_KEY = "ag_grid_tips";

type TipsStorage = Pick<Storage, "getItem" | "setItem">;

/** Hidden on this page, even where the browser keeps nothing. */
let hiddenHere = false;

function browserStorage(): TipsStorage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function gridTipsHidden(
  storage: TipsStorage | undefined = browserStorage(),
): boolean {
  if (hiddenHere) return true;
  try {
    return storage?.getItem(STORAGE_KEY) === "hidden";
  } catch {
    return false;
  }
}

export function hideGridTips(
  storage: TipsStorage | undefined = browserStorage(),
): void {
  hiddenHere = true;
  try {
    storage?.setItem(STORAGE_KEY, "hidden");
  } catch {
    // Storage can be blocked: the tips stay hidden until the page reloads.
  }
}
