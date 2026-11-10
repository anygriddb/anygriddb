import { describe, expect, it } from "vitest";
import { orderColumns, visibleColumns } from "./column-layout";

describe("orderColumns", () => {
  const columns = [
    { name: "prenom", isPrimary: true },
    { name: "nom", isPrimary: false },
    { name: "role", isPrimary: false },
  ];

  it("follows fieldOrder, the primary field first", () => {
    expect(
      orderColumns(columns, ["role", "nom", "prenom"]).map(
        (column) => column.name,
      ),
    ).toEqual(["prenom", "role", "nom"]);
  });

  it("appends columns missing from the order", () => {
    expect(
      orderColumns(columns, ["role"]).map((column) => column.name),
    ).toEqual(["prenom", "role", "nom"]);
  });
});

describe("visibleColumns", () => {
  const columns = [
    { name: "prenom", isPrimary: true },
    { name: "nom", isPrimary: false },
  ];

  it("hides the fields listed, never the primary", () => {
    expect(
      visibleColumns(columns, ["prenom", "nom"]).map((column) => column.name),
    ).toEqual(["prenom"]);
  });

  it("keeps every column when nothing is hidden", () => {
    expect(visibleColumns(columns, undefined)).toEqual(columns);
  });
});
