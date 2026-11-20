import { describe, expect, it } from "vitest";
import {
  columnLabelSchema,
  deriveColumnName,
  labelSchema,
  tidyLabel,
} from "./names";

describe("deriveColumnName", () => {
  it("slugs labels and avoids clashes and reserved names", () => {
    expect(deriveColumnName("Prix TTC (€)", new Set())).toBe("prix_ttc");
    expect(deriveColumnName("Prix TTC", new Set(["prix_ttc"]))).toBe(
      "prix_ttc_2",
    );
    expect(deriveColumnName("2024", new Set())).toBe("f_2024");
    expect(deriveColumnName("id", new Set())).toBe("f_id");
    expect(deriveColumnName("ag_seq", new Set())).toBe("f_ag_seq");
    expect(deriveColumnName("🙂", new Set())).toBe("field");
  });

  it("refuses labels with braces or control characters", () => {
    expect(columnLabelSchema.safeParse("Nom / Prénom").success).toBe(true);
    expect(columnLabelSchema.safeParse("{x}").success).toBe(false);
    expect(columnLabelSchema.safeParse("a\u0007b").success).toBe(false);
  });
});

describe("labelSchema", () => {
  const takes = (name: string) => labelSchema.safeParse(name).success;

  it("takes a name as people write one, its signs with it", () => {
    for (const name of [
      "Orders",
      "Dépenses > 100 €",
      "Revenus, par mois",
      "Taux de marge %",
      "Entrées — sorties",
      "€ payés",
      "(archive) 2024",
      "José O’Neil",
      "📊 Ventes",
      "案件",
    ]) {
      expect(takes(name), name).toBe(true);
    }
    // Spaces around a name are not part of it.
    expect(labelSchema.parse("  Orders  ")).toBe("Orders");
  });

  it("refuses a name with nothing to read, of more than a line, or too long", () => {
    for (const name of [
      "",
      "   ",
      "—",
      "***",
      "€ %",
      "a\nb",
      "a\tb",
      "a\u2028b",
    ]) {
      expect(takes(name), JSON.stringify(name)).toBe(false);
    }
    expect(takes("a".repeat(80))).toBe(true);
    expect(takes("a".repeat(81))).toBe(false);
  });

  it("refuses the marks that turn a text around", () => {
    // Read from the right, "Annual\u202Efdp.exe" shows as "Annualexe.pdf".
    expect(takes("Annual\u202Efdp.exe")).toBe(false);
    expect(takes("a\u2066b")).toBe(false);
  });
});

describe("tidyLabel", () => {
  it("keeps what a name may hold and makes one line of the rest", () => {
    expect(tidyLabel("  Ventes,\n2026 — €  ")).toBe("Ventes, 2026 — €");
    expect(tidyLabel("a\u202Eb")).toBe("a b");
    expect(tidyLabel("x".repeat(200))).toHaveLength(80);
  });

  it("leaves nothing of what holds no name", () => {
    expect(tidyLabel(" \n\t ")).toBe("");
  });
});
