import { describe, expect, it } from "vitest";
import { inferFieldType } from "./import-infer";

describe("inferFieldType", () => {
  it("recognises numbers, dates, booleans, emails, and repeated choices", () => {
    expect(inferFieldType(["1", "2,5", "", "1 000"]).fieldType).toBe("number");
    expect(inferFieldType(["2026-11-07", "07/11/2026"]).fieldType).toBe("date");
    expect(inferFieldType(["2026-11-07T10:30:00Z"]).fieldType).toBe("datetime");
    expect(inferFieldType(["oui", "non", "oui"]).fieldType).toBe("boolean");
    expect(inferFieldType(["a@example.org", "c@example.com"]).fieldType).toBe(
      "email",
    );
    const status = inferFieldType([
      "Open",
      "Done",
      "Open",
      "Open",
      "Done",
      "Done",
      "Open",
      "Done",
      "Open",
    ]);
    expect(status.fieldType).toBe("single_select");
    expect(status.options?.map((option) => option.name)).toEqual([
      "Open",
      "Done",
    ]);
  });

  it("falls back to text, and long text for long or multi-line values", () => {
    expect(inferFieldType([]).fieldType).toBe("text");
    expect(inferFieldType(["alpha", "beta", "gamma"]).fieldType).toBe("text");
    expect(inferFieldType(["line one\nline two"]).fieldType).toBe("long_text");
    expect(inferFieldType(["12", "douze"]).fieldType).toBe("text");
  });
});
