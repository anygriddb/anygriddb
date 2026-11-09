import { describe, expect, it } from "vitest";
import { acceptedLocale, madeNames } from "./made-names";

describe("made names", () => {
  it("names a grid, a copy, and an automation's reason per language", () => {
    expect(madeNames().grid).toBe("Grid");
    expect(madeNames("fr").grid).toBe("Grille");
    expect(madeNames("en").copy("Sales")).toBe("Sales (copy)");
    expect(madeNames("en").copy("Sales", 2)).toBe("Sales (copy 2)");
    expect(madeNames("fr").copy("Ventes", 3)).toBe("Ventes (copie 3)");
    expect(madeNames("fr").automation("Relance")).toBe(
      "Automatisation « Relance »",
    );
  });

  it("takes the first language an Accept-Language header prefers", () => {
    expect(acceptedLocale("fr")).toBe("fr");
    expect(acceptedLocale("fr-CH,fr;q=0.9,en;q=0.8")).toBe("fr");
    expect(acceptedLocale("de-DE,de;q=0.9,en;q=0.8,fr;q=0.7")).toBe("en");
    expect(acceptedLocale("en;q=0.5, fr;q=0.8")).toBe("fr");
    expect(acceptedLocale("EN-gb")).toBe("en");
    expect(acceptedLocale("fr;q=0, en")).toBe("en");
  });

  it("says nothing when no language it writes is accepted", () => {
    expect(acceptedLocale(undefined)).toBeUndefined();
    expect(acceptedLocale("")).toBeUndefined();
    expect(acceptedLocale("*")).toBeUndefined();
    expect(acceptedLocale("de, it;q=0.5")).toBeUndefined();
  });
});
