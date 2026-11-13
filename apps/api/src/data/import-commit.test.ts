import { describe, expect, it } from "vitest";
import { missingOptions, newTableColumns } from "./import-commit.js";

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
  it("builds definitions with the options found in the file", () => {
    const columns = newTableColumns(
      [
        { source: 0, create: { label: "Nom", fieldType: "text" } },
        { source: 1, create: { label: "Statut", fieldType: "single_select" } },
      ],
      new Map([[1, missingOptions([], ["Ouvert", "Fermé", "ouvert"], false)]]),
    );
    expect(columns[0]).toEqual({ label: "Nom", fieldType: "text" });
    expect(columns[1]?.config).toEqual({
      options: [
        { name: "Ouvert", color: expect.any(String) },
        { name: "Fermé", color: expect.any(String) },
      ],
    });
  });

  it("gives a select a first option until the file is read", () => {
    const columns = newTableColumns([
      { source: 0, create: { label: "S", fieldType: "single_select" } },
    ]);
    expect(columns[0]?.config).toEqual({
      options: [{ name: "Option", color: "gray" }],
    });
  });
});
