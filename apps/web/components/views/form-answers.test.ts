import { describe, expect, it } from "vitest";
import type { CatalogColumn } from "../../lib/types";
import { readFormAnswers } from "./form-answers";

function column(
  name: string,
  fieldType: CatalogColumn["fieldType"],
  config: Record<string, unknown> = {},
): CatalogColumn {
  return {
    name,
    label: name,
    fieldType,
    kind: fieldType === "number" ? "number" : "text",
    config,
  } as CatalogColumn;
}

const fields = [
  { column: column("summary", "text"), label: "Summary", required: true },
  { column: column("count", "number"), label: "Count", required: false },
  { column: column("contact", "email"), label: "Contact", required: false },
  { column: column("seen_on", "date"), label: "Seen on", required: true },
];
const reading = { decimalMark: "." as const, timeZone: "UTC" };

describe("readFormAnswers", () => {
  it("reads every answer as its field writes it", () => {
    expect(
      readFormAnswers(
        fields,
        {
          summary: "A fall",
          count: "2",
          contact: "nurse@example.org",
          seen_on: "2026-11-24",
        },
        { reading },
      ),
    ).toEqual({
      values: {
        summary: "A fall",
        count: "2",
        contact: "nurse@example.org",
        seen_on: "2026-11-24",
      },
      problems: [],
    });
  });

  it("says every answer missing or refused, each by its field, in their order", () => {
    const { problems } = readFormAnswers(
      fields,
      { count: "twelve", contact: "not an address" },
      { reading },
    );
    expect(problems.map(({ column, kind }) => [column, kind])).toEqual([
      ["summary", "required"],
      ["count", "refused"],
      ["contact", "refused"],
      ["seen_on", "required"],
    ]);
    expect(problems[0]?.label).toBe("Summary");
  });

  it("leaves an empty answer out when the field may be empty", () => {
    expect(
      readFormAnswers(
        fields,
        {
          summary: "x",
          count: "",
          contact: [],
          seen_on: "2026-11-24",
        },
        { reading },
      ).values,
    ).toEqual({ summary: "x", seen_on: "2026-11-24" });
  });

  it("reads what a link gave with a decimal point, whatever the language", () => {
    const french = { decimalMark: "," as const, timeZone: "UTC" };
    const typed = readFormAnswers(
      fields.slice(1, 2),
      { count: "1.234" },
      { reading: french },
    );
    expect(typed.problems).toHaveLength(1);
    const given = readFormAnswers(
      fields.slice(1, 2),
      { count: "1.234" },
      {
        reading: french,
        given: { count: "1.234" },
      },
    );
    expect(given.values).toEqual({ count: "1.234" });
  });

  it("sends a link to one row as the row's id", () => {
    const link = column("patient", "relation_one_to_many");
    expect(
      readFormAnswers(
        [{ column: link, label: "Patient", required: true }],
        { patient: "row-1" },
        { reading, oneRow: (item) => item.name === "patient" },
      ).values,
    ).toEqual({ patient: ["row-1"] });
  });
});
