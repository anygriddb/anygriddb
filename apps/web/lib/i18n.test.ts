import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { reasonOf } from "./errors";
import { browserLocale } from "./i18n";

/** The msgid and msgstr of every message of a PO catalog. */
function catalog(locale: string): Array<{ id: string; text: string }> {
  const po = readFileSync(`locales/${locale}/messages.po`, "utf8");
  return [...po.matchAll(/^msgid (".*")\nmsgstr (".*")$/gm)]
    .map((match) => ({
      id: JSON.parse(match[1] ?? '""') as string,
      text: JSON.parse(match[2] ?? '""') as string,
    }))
    .filter((entry) => entry.id !== "");
}

function placeholderNames(text: string): string[] {
  return [...text.matchAll(/\{(\w+)[,}]/g)]
    .map((match) => match[1])
    .filter((name): name is string => name !== undefined)
    .sort();
}

describe("i18n", () => {
  it("keeps an English identity catalog for the source locale", () => {
    const english = catalog("en");
    expect(english.length).toBeGreaterThan(900);
    expect(english.filter((entry) => entry.text === "")).toEqual([]);
  });

  it("has a French translation for every message", () => {
    const french = catalog("fr");
    expect(french.length).toBeGreaterThan(900);
    expect(french.filter((entry) => entry.text === "")).toEqual([]);
  });

  it("keeps every placeholder in the French text", () => {
    for (const entry of catalog("fr")) {
      expect(placeholderNames(entry.text), entry.id).toEqual(
        placeholderNames(entry.id),
      );
    }
  });

  it("keeps every placeholder in the English text", () => {
    for (const entry of catalog("en")) {
      expect(placeholderNames(entry.text), entry.id).toEqual(
        placeholderNames(entry.id),
      );
    }
  });

  it("takes the first browser language the app speaks", () => {
    expect(browserLocale(["fr-FR", "en-US"])).toBe("fr");
    expect(browserLocale(["de-DE", "fr-CA", "en"])).toBe("fr");
    expect(browserLocale(["en-GB"])).toBe("en");
    // None spoken: the instance's default decides.
    expect(browserLocale(["de-DE", "es"])).toBeNull();
    expect(browserLocale([])).toBeNull();
    // A tag that only begins like a language is not that language.
    expect(browserLocale(["fry", "enx"])).toBeNull();
  });

  it("reads the code of a failure wherever it comes from", () => {
    expect(
      reasonOf({ data: { reason: { code: "row_locked" } }, message: "x" }),
    ).toEqual({ code: "row_locked" });
    expect(
      reasonOf({
        error: "Unknown column: prix",
        code: "unknown_column",
        detail: "prix",
      }),
    ).toEqual({ code: "unknown_column", detail: "prix" });
    expect(reasonOf({ reason: { code: "too_many_rows" }, error: "x" })).toEqual(
      { code: "too_many_rows" },
    );
    // An unknown code, or no code at all, is a plain refusal.
    expect(reasonOf({ code: "made_up" })).toEqual({ code: "request_rejected" });
    expect(reasonOf(new Error("Unknown column: prix"))).toEqual({
      code: "request_rejected",
    });
  });
});
