/**
 * Edits on texts that come from outside (a client's type names, numbers,
 * labels) done in one pass. A regular expression such as `/0+$/` or
 * `/\(.*$/` is tried again at every position: on a long text built for it,
 * a run of `0` or `(`, it turns quadratic.
 */

/** `text` without `char` repeated at its end: `12.500`, `"0"` → `12.5`. */
export function trimEndRun(text: string, char: string): string {
  let end = text.length;
  while (end > 0 && text[end - 1] === char) end -= 1;
  return text.slice(0, end);
}

/** `text` without `char` repeated at either end: `__a_b__` → `a_b`. */
export function trimRuns(text: string, char: string): string {
  let start = 0;
  while (start < text.length && text[start] === char) start += 1;
  return trimEndRun(text.slice(start), char);
}

/** `text` up to the first `char`, or whole: `decimal(10,2)` → `decimal`. */
export function cutAt(text: string, char: string): string {
  const at = text.indexOf(char);
  return at < 0 ? text : text.slice(0, at);
}

/** `text` up to its first white space, or whole: `int unsigned` → `int`. */
export function cutAtSpace(text: string): string {
  const at = text.search(/\s/);
  return at < 0 ? text : text.slice(0, at);
}

/**
 * `text` without each `(…)` group, up to the first `)` after its `(`:
 * `timestamp(3) with time zone` → `timestamp with time zone`. A `(` that
 * no `)` closes stays, with what follows it.
 */
export function withoutGroups(text: string): string {
  let out = "";
  let from = 0;
  for (;;) {
    const open = text.indexOf("(", from);
    if (open < 0) break;
    const close = text.indexOf(")", open + 1);
    if (close < 0) break;
    out += text.slice(from, open);
    from = close + 1;
  }
  return out + text.slice(from);
}

/**
 * `text` without everything from its first `(` to its last `)`:
 * `numeric(12,2)[]` → `numeric[]`. Without both, `text` stays.
 */
export function withoutOuterGroup(text: string): string {
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  return open >= 0 && close > open
    ? text.slice(0, open) + text.slice(close + 1)
    : text;
}
