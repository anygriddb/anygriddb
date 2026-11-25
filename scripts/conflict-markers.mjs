/**
 * A line a merge left unresolved: `<<<<<<<`, `|||||||` (the common
 * ancestor) or `>>>>>>>`, as Git writes them, or as Prettier rewrites them
 * inside a list, a table or a quote. `=======` alone is not asked: in
 * Markdown it underlines a title.
 */
const MARKER = /^[\s|]*(?:<{7}|\|{7}|>{7})(?:\s|$)|^\s*(?:> ){6}>(?:\s|$)/;

/** The numbers (from 1) of the lines of `text` a merge left unresolved. */
export function conflictMarkers(text) {
  return text
    .split("\n")
    .flatMap((line, index) => (MARKER.test(line) ? [index + 1] : []));
}
