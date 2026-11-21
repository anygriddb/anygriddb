import {
  visibleFormFields,
  type FilterKind,
  type ViewConfig,
} from "@anygriddb/core";
import { describe, expect, it } from "vitest";
import { publicConfig } from "./share-config.js";

describe("a view's settings on a public link", () => {
  it("names no field the link does not show", () => {
    const config: ViewConfig = {
      fieldOrder: ["name", "salary"],
      hiddenFields: ["salary"],
      columnWidths: { name: 120, salary: 90 },
      titleColumn: "salary",
      stackColumn: "name",
      cardFields: ["name", "salary"],
    };
    const given = publicConfig(config, ["name"]);
    expect(JSON.stringify(given)).not.toContain("salary");
    expect(given).toEqual({
      fieldOrder: ["name"],
      columnWidths: { name: 120 },
      stackColumn: "name",
      cardFields: ["name"],
    });
  });

  it("keeps what it shows as it is", () => {
    const config: ViewConfig = {
      fieldOrder: ["name", "city"],
      titleColumn: "city",
    };
    expect(publicConfig(config, ["name", "city"])).toEqual(config);
  });

  it("masks a form's hidden field and reaches the server's answer", () => {
    const fields = [
      { column: "salary", label: "Salary band", hidden: true },
      { column: "name" },
      {
        column: "note",
        showIf: {
          conjunction: "and" as const,
          conditions: [
            { column: "salary", op: "is_not_empty" as const },
            { column: "name", op: "is_not_empty" as const },
          ],
        },
      },
    ];
    const given = publicConfig({ form: { fields } }, ["name", "note"]);
    expect(JSON.stringify(given)).not.toMatch(/salary/i);
    // What a browser knows: the kinds of the fields the link shows.
    const context = {
      timeZone: "UTC",
      kinds: new Map<string, FilterKind>([
        ["name", "text"],
        ["note", "text"],
      ]),
    };
    const answers = { name: "Ada", salary: "kept" };
    expect(
      visibleFormFields(given.form?.fields ?? [], answers, context),
    ).toEqual(visibleFormFields(fields, answers, context));
  });
});
