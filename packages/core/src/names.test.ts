import { describe, expect, it } from "vitest";
import { columnLabelSchema, deriveColumnName } from "./names";

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
