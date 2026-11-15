/**
 * The text of a JSON field: an object or a list, in one spelling, a space
 * after each colon and each comma and none elsewhere, which is how
 * PostgreSQL's jsonb and MySQL's JSON print a document. The engines that
 * keep a document as text are given that spelling. Nothing here reads a
 * number or a string of the document into a JavaScript value and writes
 * it back: a number of forty digits and `1.50` leave as they came.
 */

/** The longest document a JSON field takes, in its kept spelling. */
export const JSON_MAX_CHARS = 20_000;

/**
 * How deep a document nests at most: what MySQL's JSON type takes, the
 * lowest of the engines' limits.
 */
export const JSON_MAX_DEPTH = 100;

const SPACE = new Set([" ", "\t", "\n", "\r"]);

/**
 * Walks a text already known to be JSON, part by part: a string whole, a
 * bracket, a comma or a colon, or a run of anything else (a number,
 * `true`, `false`, `null`). Spaces between parts are skipped.
 */
function* parts(text: string): Generator<string> {
  let at = 0;
  while (at < text.length) {
    const char = text.charAt(at);
    if (SPACE.has(char)) {
      at += 1;
      continue;
    }
    if (char === '"') {
      let end = at + 1;
      while (end < text.length && text.charAt(end) !== '"') {
        end += text.charAt(end) === "\\" ? 2 : 1;
      }
      yield text.slice(at, end + 1);
      at = end + 1;
      continue;
    }
    if ("{}[],:".includes(char)) {
      yield char;
      at += 1;
      continue;
    }
    let end = at + 1;
    while (
      end < text.length &&
      !SPACE.has(text.charAt(end)) &&
      !'{}[],:"'.includes(text.charAt(end))
    ) {
      end += 1;
    }
    yield text.slice(at, end);
    at = end;
  }
}

/**
 * A typed text as the document a JSON field keeps, in its one spelling.
 * `undefined` when it is not JSON, is a bare value (`12`, `"a"`, `null`),
 * nests too deep or is too long.
 */
export function parseJsonDocument(text: string): string | undefined {
  const trimmed = text.trim();
  const first = trimmed.charAt(0);
  // The cheap refusals first: nothing of a long text is parsed.
  if (first !== "{" && first !== "[") return undefined;
  if (trimmed.length > JSON_MAX_CHARS * 10) return undefined;
  try {
    JSON.parse(trimmed);
  } catch {
    // Not JSON, or nested past what the parser itself takes.
    return undefined;
  }
  let kept = "";
  let depth = 0;
  for (const part of parts(trimmed)) {
    if (part === "{" || part === "[") {
      depth += 1;
      if (depth > JSON_MAX_DEPTH) return undefined;
    } else if (part === "}" || part === "]") {
      depth -= 1;
    }
    kept += part === "," || part === ":" ? `${part} ` : part;
    if (kept.length > JSON_MAX_CHARS) return undefined;
  }
  return kept;
}

/** True for a text a JSON field takes, however its parts are spaced. */
export function isJsonDocument(value: unknown): value is string {
  return typeof value === "string" && parseJsonDocument(value) !== undefined;
}

/**
 * A document set out to be read and edited: a member or an item a line,
 * two spaces a level. A text that is no document comes back as it is.
 */
export function prettyJson(text: string): string {
  if (parseJsonDocument(text) === undefined) return text;
  let out = "";
  let depth = 0;
  let previous = "";
  const line = () => `\n${"  ".repeat(depth)}`;
  for (const part of parts(text)) {
    if (part === "}" || part === "]") {
      depth -= 1;
      // An empty object or list stays on its line: `{}`, `[]`.
      out += previous === "{" || previous === "[" ? part : `${line()}${part}`;
    } else if (part === ",") {
      out += part;
    } else if (part === ":") {
      out += ": ";
    } else {
      // A value follows its member's name on the same line; a name, an
      // item, and whatever a list holds start a line of their own.
      out += previous === ":" || previous === "" ? part : `${line()}${part}`;
      if (part === "{" || part === "[") depth += 1;
    }
    previous = part;
  }
  return out;
}

/**
 * A document as the change trail keeps it, where a row's values are JSON
 * themselves and a document is the object or the list it is, back as the
 * text a cell holds.
 */
export function jsonCellText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || typeof value !== "object") return "";
  return parseJsonDocument(JSON.stringify(value)) ?? "";
}
