import { describe, expect, it } from "vitest";
import { FieldGuess, inferFieldType } from "./import-infer";

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

describe("FieldGuess", () => {
  it("guesses from every value it is given, past the first 2,000", () => {
    const values = [
      ...Array.from({ length: 2_500 }, (_, index) => String(index)),
      "not a number",
    ];
    const guess = new FieldGuess();
    for (const value of values) guess.add(value);
    expect(guess.result().fieldType).toBe("text");
    // The sample stops before the text.
    expect(inferFieldType(values).fieldType).toBe("number");
  });

  it("keeps a select only while its values repeat, and stays text otherwise", () => {
    const repeated = new FieldGuess();
    for (let index = 0; index < 1_000; index += 1) {
      repeated.add(index % 2 === 0 ? "Open" : "Done");
    }
    expect(repeated.result()).toMatchObject({
      fieldType: "single_select",
      options: [{ name: "Open" }, { name: "Done" }],
    });
    const varied = new FieldGuess();
    for (let index = 0; index < 1_000; index += 1) varied.add(`Item ${index}`);
    expect(varied.result().fieldType).toBe("text");
    expect(new FieldGuess().result().fieldType).toBe("text");
  });
});
