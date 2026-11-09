/**
 * Regular expressions a formula writes (REGEX_MATCH, REGEX_EXTRACT,
 * REGEX_REPLACE): a portable subset, read the same by PostgreSQL's AREs,
 * MySQL's ICU, and MariaDB's PCRE2, and rewritten in constructs all three
 * share. The pattern is written in the formula and checked when the field
 * is saved, so no row can fail the read with a pattern an engine rejects.
 *
 * - Characters, `.` (any character but a newline), `^` and `$` (the start
 *   and the end of the text), classes `[a-z]` and `[^…]`.
 * - `\d`, `\w`, `\s` and their negations are ASCII: `[0-9]`,
 *   `[A-Za-z0-9_]`, and space, tab, and line breaks. `\b` is the edge of
 *   such a word. `\n`, `\t`, `\r`, and `\` before a sign.
 * - Groups `(…)` (nine at most), `(?:…)`, lookaheads `(?=…)`, `(?!…)`.
 * - Alternatives `|`; `*`, `+`, `?`, `{n}`, `{n,}`, `{n,m}` up to 255,
 *   each also lazy (`*?`).
 * - A leading `(?i)` ignores case.
 *
 * Refused: back-references, lookbehinds, named groups, Unicode classes,
 * possessive quantifiers. Where the engines would choose another match,
 * that is, with an alternative or a lazy quantifier, PostgreSQL takes the
 * longest and the others the first: the pattern says it is `ambiguous`,
 * and the field carries the engine's limit (ADR 0027).
 */
import { AppError } from "../errors";

export type PortableRegex = {
  /** The pattern in the shared syntax, without its case option. */
  pattern: string;
  /** Capturing groups, which a replacement may name as `$1` to `$9`. */
  groups: number;
  caseless: boolean;
  /** An alternative or a lazy quantifier: the match chosen may differ. */
  ambiguous: boolean;
};

/** A replacement's parts: text as it is, or a group (0 is the whole match). */
export type ReplacementPart = { text: string } | { group: number };

const MAX_GROUPS = 9;
const MAX_REPEAT = 255;
const WORD = "A-Za-z0-9_";
// No `\v`: ICU and PCRE2 read it as a class of vertical spaces.
const SPACE = " \\t\\n\\r\\f";
/** Any one character, a newline included: `.` does not match one. */
const ANY = "(?:[^\\n]|\\n)";
const SIGNS = new Set("\\^$.|?*+()[]{}/-".split(""));

/** `\d`, `\w`, `\s` as the inside of a class. */
const CLASS_OF: Record<string, string> = { d: "0-9", w: WORD, s: SPACE };
const CHAR_OF: Record<string, string> = { n: "\\n", t: "\\t", r: "\\r" };

function refuse(fn: string): never {
  throw new AppError("invalid_arguments", fn);
}

/** Checks `source` against the portable subset, and rewrites it. */
export function portableRegex(source: string, fn: string): PortableRegex {
  if (source.length === 0 || source.length > 500) refuse(fn);
  let rest = source;
  let caseless = false;
  if (rest.startsWith("(?i)")) {
    caseless = true;
    rest = rest.slice(4);
  }
  let out = "";
  let groups = 0;
  let depth = 0;
  let ambiguous = false;
  // Whether what precedes can take a quantifier.
  let atom = false;
  let index = 0;
  const peek = (offset = 0) => rest[index + offset] ?? "";
  while (index < rest.length) {
    const char = peek();
    if (char === "\\") {
      const next = peek(1);
      index += 2;
      if (next in CLASS_OF) {
        out += `[${CLASS_OF[next] ?? ""}]`;
      } else if (
        next.toLowerCase() in CLASS_OF &&
        next !== next.toLowerCase()
      ) {
        out += `[^${CLASS_OF[next.toLowerCase()] ?? ""}]`;
      } else if (next in CHAR_OF) {
        out += CHAR_OF[next] ?? "";
      } else if (next === "b") {
        // A word's edge, as lookarounds of one character every engine reads.
        out += `(?:(?<![${WORD}])(?=[${WORD}])|(?<=[${WORD}])(?![${WORD}]))`;
        atom = false;
        continue;
      } else if (SIGNS.has(next)) {
        out += `\\${next}`;
      } else {
        refuse(fn);
      }
      atom = true;
      continue;
    }
    if (char === "[") {
      const [cls, length] = readClass(rest.slice(index), fn);
      out += cls;
      index += length;
      atom = true;
      continue;
    }
    if (char === "(") {
      const head = rest.slice(index, index + 3);
      if (head === "(?:" || head === "(?=" || head === "(?!") {
        out += head;
        index += 3;
      } else if (peek(1) === "?") {
        refuse(fn);
      } else {
        groups += 1;
        if (groups > MAX_GROUPS) refuse(fn);
        out += "(";
        index += 1;
      }
      depth += 1;
      atom = false;
      continue;
    }
    if (char === ")") {
      if (depth === 0) refuse(fn);
      depth -= 1;
      out += ")";
      index += 1;
      atom = true;
      continue;
    }
    if (char === "|") {
      ambiguous = true;
      out += "|";
      index += 1;
      atom = false;
      continue;
    }
    if (char === "*" || char === "+" || char === "?" || char === "{") {
      if (!atom) refuse(fn);
      let quantifier = char;
      if (char === "{") {
        const bounds = /^\{(\d{1,3})(,(\d{1,3})?)?\}/.exec(rest.slice(index));
        if (!bounds) refuse(fn);
        const low = Number(bounds[1]);
        const high = bounds[3] === undefined ? undefined : Number(bounds[3]);
        if (
          low > MAX_REPEAT ||
          (high !== undefined && (high > MAX_REPEAT || high < low))
        ) {
          refuse(fn);
        }
        quantifier = bounds[0];
      }
      index += quantifier.length;
      if (peek() === "?") {
        ambiguous = true;
        quantifier += "?";
        index += 1;
      }
      // A quantifier on a quantifier: possessive in PCRE, refused in AREs.
      if ("*+?{".includes(peek()) && peek() !== "") refuse(fn);
      out += quantifier;
      atom = false;
      continue;
    }
    if (char === ".") {
      out += "[^\\n]";
      index += 1;
      atom = true;
      continue;
    }
    if (char === "^") {
      out += "^";
      index += 1;
      atom = false;
      continue;
    }
    if (char === "$") {
      // The end of the text only: ICU and PCRE would also match before a
      // final newline.
      out += `(?!${ANY})`;
      index += 1;
      atom = false;
      continue;
    }
    if (char === "]" || char === "}") refuse(fn);
    out += char;
    index += char.length;
    atom = true;
  }
  if (depth !== 0) refuse(fn);
  return { pattern: out, groups, caseless, ambiguous };
}

/**
 * A class from `[` to its `]`, rewritten with every sign escaped; the
 * number of characters read.
 */
function readClass(text: string, fn: string): [string, number] {
  let index = 1;
  let out = "[";
  if (text[index] === "^") {
    out += "^";
    index += 1;
  }
  let empty = true;
  while (index < text.length) {
    const char = text[index] ?? "";
    if (char === "]" && !empty) return [`${out}]`, index + 1];
    if (char === "\\") {
      const next = text[index + 1] ?? "";
      index += 2;
      if (next in CLASS_OF) out += CLASS_OF[next] ?? "";
      else if (next in CHAR_OF) out += CHAR_OF[next] ?? "";
      else if (SIGNS.has(next)) out += `\\${next}`;
      else refuse(fn);
      empty = false;
      continue;
    }
    if (char === "-" && !empty && text[index + 1] !== "]") {
      out += "-";
      index += 1;
      continue;
    }
    // `[` would open a POSIX class in some engines; `]` first, `^` later,
    // and a `-` at an edge are plain characters.
    out +=
      char === "[" || char === "]" || char === "^" || char === "-"
        ? `\\${char}`
        : char;
    index += 1;
    empty = false;
  }
  return refuse(fn);
}

/**
 * A replacement written in the formula: `$1` to `$9` for a group, `$&`
 * for the whole match, `$$` for a dollar; the rest as it is.
 */
export function regexReplacement(
  source: string,
  groups: number,
  fn: string,
): ReplacementPart[] {
  const parts: ReplacementPart[] = [];
  let text = "";
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index] ?? "";
    const next = source[index + 1] ?? "";
    if (char === "$" && (next === "$" || next === "&" || /\d/.test(next))) {
      index += 1;
      if (next === "$") {
        text += "$";
        continue;
      }
      const group = next === "&" ? 0 : Number(next);
      if (group > groups) refuse(fn);
      if (text) parts.push({ text });
      text = "";
      parts.push({ group });
      continue;
    }
    text += char;
  }
  if (text) parts.push({ text });
  return parts;
}
