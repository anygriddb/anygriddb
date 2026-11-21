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

/** A NUL, or half of a surrogate pair: `u` reads a whole pair as one. */
const UNWRITABLE = /[\0\p{Cs}]/u;

/**
 * Whether a value from outside holds a text nothing can keep: PostgreSQL's
 * text takes no NUL, its JSON no half of a surrogate pair, and a name
 * lookup throws on either. Objects and arrays are walked with a list, not
 * by recursion: a body may be nested as deep as its size allows. What is
 * under an `echoed` key is what the caller read and sends back to compare,
 * which a client's database may hold.
 */
export function holdsUnwritableText(
  value: unknown,
  echoed: ReadonlySet<string> = new Set(),
): boolean {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const item = pending.pop();
    if (typeof item === "string") {
      if (UNWRITABLE.test(item)) return true;
    } else if (Array.isArray(item)) {
      for (const inner of item as unknown[]) pending.push(inner);
    } else if (typeof item === "object" && item !== null) {
      // A plain object, or the bare kind a query string parses into; a
      // buffer, a date or a stream has a longer line of prototypes.
      const kind = Object.getPrototypeOf(item) as object | null;
      if (kind !== null && Object.getPrototypeOf(kind) !== null) continue;
      for (const [key, inner] of Object.entries(item)) {
        if (UNWRITABLE.test(key)) return true;
        if (!echoed.has(key)) pending.push(inner);
      }
    }
  }
  return false;
}
