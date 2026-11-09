import type { CatalogColumn } from "../../lib/types";

export type FormValue = string | string[] | boolean;

type Option = { name: string };

const TRUE_WORDS = new Set(["1", "true", "yes", "oui", "on", "x"]);
const FALSE_WORDS = new Set(["0", "false", "no", "non", "off", ""]);

function optionNames(column: CatalogColumn): string[] {
  const options = (column.config as { options?: Option[] }).options ?? [];
  return options.map((option) => option.name);
}

function pick(names: readonly string[], text: string): string | undefined {
  const wanted = text.trim().toLowerCase();
  return names.find((name) => name.toLowerCase() === wanted);
}

/** A typed value as the form's input holds it, or undefined. */
function inputValue(
  column: CatalogColumn,
  text: string,
): FormValue | undefined {
  switch (column.fieldType) {
    case "boolean": {
      const word = text.trim().toLowerCase();
      if (TRUE_WORDS.has(word)) return true;
      if (FALSE_WORDS.has(word)) return false;
      return undefined;
    }
    case "single_select":
      return pick(optionNames(column), text);
    case "multi_select": {
      const names = optionNames(column);
      const chosen = text.split(",").flatMap((part) => pick(names, part) ?? []);
      return chosen.length > 0 ? [...new Set(chosen)] : undefined;
    }
    case "user":
    case "attachment":
      // People and files are chosen, not typed in a link.
      return undefined;
    default:
      return text.length > 0 ? text.slice(0, 10_000) : undefined;
  }
}

/**
 * What a link fills in a form: `?prefill_<field>=value` fills a field of
 * the form, named by its column name or its label; `?hide_<field>=true`
 * also hides a filled field, which is still sent. A name outside the
 * form, a value the field cannot take, a person, and a file are ignored:
 * a link fills only what the form asks. The submission is checked as if
 * it had been typed.
 */
export function formPrefill(
  search: string,
  columns: readonly CatalogColumn[],
): { values: Record<string, FormValue>; hidden: Set<string> } {
  const params = new URLSearchParams(search);
  const values: Record<string, FormValue> = {};
  const hide = new Set<string>();
  const find = (key: string) => {
    const wanted = key.trim().toLowerCase();
    return (
      columns.find((column) => column.name === key) ??
      columns.find((column) => column.label.trim().toLowerCase() === wanted)
    );
  };
  for (const [key, text] of params) {
    if (key.startsWith("prefill_")) {
      const column = find(key.slice("prefill_".length));
      const value = column ? inputValue(column, text) : undefined;
      if (column && value !== undefined) values[column.name] = value;
    } else if (key.startsWith("hide_") && TRUE_WORDS.has(text.toLowerCase())) {
      const column = find(key.slice("hide_".length));
      if (column) hide.add(column.name);
    }
  }
  const hidden = new Set([...hide].filter((name) => name in values));
  return { values, hidden };
}
