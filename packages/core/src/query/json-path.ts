/**
 * JSON paths a formula writes (JSON_EXTRACT): a portable subset that
 * PostgreSQL's jsonpath, MySQL's and MariaDB's paths, and SQL Server's
 * read the same. `$` then steps: `.name`, `["any name"]`, `[n]`. A path
 * without `$` (`.a.b`, as jq writes it) starts there.
 */
import { AppError } from "../errors";

/** One step of a JSON path: a member's name, or a place in a list (from 0). */
export type JsonStep = { key: string } | { index: number };

const MAX_STEPS = 32;
const NAME = /^[\p{L}_][\p{L}\p{N}_]*/u;

/** The steps of a path, or `invalid_arguments` naming JSON_EXTRACT. */
export function parseJsonPath(text: string): JsonStep[] {
  const fail = (): never => {
    throw new AppError("invalid_arguments", "json_extract");
  };
  let rest = text.trim();
  if (rest.length > 1_000) fail();
  if (rest.startsWith("$")) rest = rest.slice(1);
  else if (!rest.startsWith(".") && !rest.startsWith("[")) fail();
  const steps: JsonStep[] = [];
  while (rest.length > 0) {
    if (steps.length >= MAX_STEPS) fail();
    if (rest.startsWith(".")) {
      rest = rest.slice(1);
      if (rest.startsWith('"')) {
        const [key, after] = quoted(rest) ?? fail();
        steps.push({ key });
        rest = after;
        continue;
      }
      const name = NAME.exec(rest)?.[0] ?? fail();
      steps.push({ key: name });
      rest = rest.slice(name.length);
      continue;
    }
    if (rest.startsWith("[")) {
      const inner = rest.slice(1);
      const index = /^(\d{1,7})\]/.exec(inner);
      if (index) {
        steps.push({ index: Number(index[1]) });
        rest = inner.slice(index[0].length);
        continue;
      }
      const [key, after] = quoted(inner) ?? fail();
      if (!after.startsWith("]")) fail();
      steps.push({ key });
      rest = after.slice(1);
      continue;
    }
    fail();
  }
  return steps;
}

/** A quoted name at the start of `text` (`"…"` or `'…'`), and what follows. */
function quoted(text: string): [string, string] | undefined {
  const quote = text[0];
  if (quote !== '"' && quote !== "'") return undefined;
  let key = "";
  for (let index = 1; index < text.length; index += 1) {
    const char = text[index] ?? "";
    if (char === "\\") {
      const next = text[index + 1];
      if (next === undefined) return undefined;
      key += next;
      index += 1;
      continue;
    }
    if (char === quote) return [key, text.slice(index + 1)];
    key += char;
  }
  return undefined;
}

/** A path's steps, names quoted as JSON strings: `."a"[0]`. */
export function jsonSteps(path: readonly JsonStep[]): string {
  return path
    .map((step) =>
      "key" in step
        ? `.${JSON.stringify(step.key)}`
        : `[${String(step.index)}]`,
    )
    .join("");
}

/** A path as MySQL, MariaDB, and SQL Server write it: `$."a"[0]`. */
export function jsonPathText(path: readonly JsonStep[]): string {
  return `$${jsonSteps(path)}`;
}
