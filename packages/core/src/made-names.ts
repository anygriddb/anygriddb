/**
 * Names AnyGridDB makes up when a person gives none: a new table's grid,
 * a copy, a field or view an import found unnamed, the reason an
 * automation's writes carry. They are data everyone reads and may rename,
 * so each is written once, in one language: the one the person who asked
 * reads the app in, else the instance's default (ADR 0041).
 */

const NAME_LOCALES = ["en", "fr"] as const;

export type NameLocale = (typeof NAME_LOCALES)[number];

export type MadeNames = {
  /** The language they are written in. */
  locale: NameLocale;
  /** A new table's first view. */
  grid: string;
  /** A copy's name; `index` from 2 when the first is taken. */
  copy: (name: string, index?: number) => string;
  /** A field an import found without a name. */
  field: string;
  /** The text field of a table that came without one. */
  name: string;
  /** A view an import found without a name. */
  view: string;
  /** The reason written on the rows an automation changes. */
  automation: (name: string) => string;
};

const NAMES: Record<NameLocale, MadeNames> = {
  en: {
    locale: "en",
    grid: "Grid",
    copy: (name, index) =>
      index === undefined ? `${name} (copy)` : `${name} (copy ${index})`,
    field: "Field",
    name: "Name",
    view: "View",
    automation: (name) => `Automation “${name}”`,
  },
  fr: {
    locale: "fr",
    grid: "Grille",
    copy: (name, index) =>
      index === undefined ? `${name} (copie)` : `${name} (copie ${index})`,
    field: "Champ",
    name: "Nom",
    view: "Vue",
    automation: (name) => `Automatisation «\u00a0${name}\u00a0»`,
  },
};

/** The names in a language; English, the source language, by default. */
export function madeNames(locale: NameLocale = "en"): MadeNames {
  return NAMES[locale];
}

/**
 * The first language AnyGridDB writes in that an `Accept-Language` header
 * prefers (`fr-CH,fr;q=0.9,en;q=0.8` → `fr`), or undefined. The app sends
 * the language it shows; other clients usually send none.
 */
export function acceptedLocale(
  header: string | null | undefined,
): NameLocale | undefined {
  if (!header) return undefined;
  const ranked = header
    .split(",")
    .slice(0, 20)
    .map((part, order) => {
      const [tag = "", ...params] = part.trim().split(";");
      const q = params
        .map((param) => /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(param)?.[1])
        .find((value) => value !== undefined);
      const weight = q === undefined ? 1 : Number(q);
      return {
        language: tag.trim().toLowerCase().split("-")[0] ?? "",
        weight: Number.isFinite(weight) ? weight : 0,
        order,
      };
    })
    .filter((item) => item.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.order - b.order);
  for (const { language } of ranked) {
    if ((NAME_LOCALES as readonly string[]).includes(language)) {
      return language as NameLocale;
    }
  }
  return undefined;
}
