/**
 * A refusal written from `roleGrants` itself, `if (!roleGrants(…)) throw`:
 * it escapes what each way in declares (`apps/api/src/access/
 * declaration.ts`), where `demand` and `granted` note the permission they
 * ask. `roleGrants` stays for what only filters or sorts.
 */
const NEGATED = /!\s*roleGrants(?:All)?\s*\(/g;

/** The index just past the parenthesis that closes the one at `open`. */
function closing(text, open) {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === "(") depth += 1;
    else if (text[index] === ")") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return text.length;
}

/** The numbers (from 1) of the lines of `text` that refuse by hand. */
export function handRefusals(text) {
  const lines = [];
  for (const match of text.matchAll(NEGATED)) {
    // The condition this negation stands in: the `if (` before it.
    const before = text.lastIndexOf("if", match.index);
    const open = text.indexOf("(", before);
    if (before < 0 || open < 0 || open > match.index) continue;
    const between = text.slice(open + 1, match.index);
    if (/[;{}]/.test(between)) continue;
    const rest = text.slice(closing(text, open)).trimStart();
    if (/^(?:\{\s*)?throw\b/.test(rest)) {
      lines.push(text.slice(0, match.index).split("\n").length);
    }
  }
  return lines;
}
