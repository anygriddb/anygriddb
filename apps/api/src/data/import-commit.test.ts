import { describe, expect, it } from "vitest";
import { missingOptions, newTableColumns } from "./import-commit.js";

const USER = "11111111-1111-4111-8111-111111111111";

describe("missingOptions", () => {
  it("adds unknown values once, ignoring case", () => {
    const added = missingOptions(
      [{ name: "Ouvert", color: "gray" }],
      ["ouvert", "Fermé", "fermé", ""],
      false,
    );
    expect(added.map((option) => option.name)).toEqual(["Fermé"]);
  });

  it("splits lists for multiple selects and stops at 200 options", () => {
    expect(
      missingOptions([], ["a, b", "b;c"], true).map((o) => o.name),
    ).toEqual(["a", "b", "c"]);
    const many = Array.from({ length: 250 }, (_, i) => `v${i}`);
    expect(missingOptions([], many, false)).toHaveLength(200);
  });
});

describe("newTableColumns", () => {
  it("builds definitions with options taken from the data", () => {
    const staged = {
      userId: USER,
      filename: "a.csv",
      headers: ["Nom", "Statut"],
      rows: [
        ["Acme", "Ouvert"],
        ["Boréal", "Fermé"],
      ],
    };
    const columns = newTableColumns(staged, [
      { source: 0, create: { label: "Nom", fieldType: "text" } },
      { source: 1, create: { label: "Statut", fieldType: "single_select" } },
    ]);
    expect(columns[0]).toEqual({ label: "Nom", fieldType: "text" });
    expect(columns[1]?.config).toEqual({
      options: [
        { name: "Ouvert", color: expect.any(String) },
        { name: "Fermé", color: expect.any(String) },
      ],
    });
  });

  it("gives an empty select column a placeholder option", () => {
    const columns = newTableColumns(
      { userId: USER, filename: "a.csv", headers: ["S"], rows: [[""]] },
      [{ source: 0, create: { label: "S", fieldType: "single_select" } }],
    );
    expect(columns[0]?.config).toEqual({
      options: [{ name: "Option", color: "gray" }],
    });
  });
});
