const FOCUSABLE = [
  "a[href]",
  "area[href]",
  "button:not(:disabled)",
  'input:not(:disabled):not([type="hidden"])',
  "select:not(:disabled)",
  "textarea:not(:disabled)",
  "summary",
  "iframe",
  "audio[controls]",
  "video[controls]",
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/**
 * Whether a scrolling area must take Tab itself: it overflows, and nothing
 * in it can take the keyboard to scroll it there.
 */
export function needsTabStop(
  area: Pick<Element, "scrollHeight" | "clientHeight" | "querySelector">,
): boolean {
  return (
    area.scrollHeight > area.clientHeight &&
    area.querySelector(FOCUSABLE) === null
  );
}
