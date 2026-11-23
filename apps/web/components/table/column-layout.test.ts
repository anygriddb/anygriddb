import { describe, expect, it } from "vitest";
import { fieldBeside, orderColumns, visibleColumns } from "./column-layout";

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

describe("fieldBeside", () => {
  const columns = [
    { name: "prenom", isPrimary: true },
    { name: "nom", isPrimary: false },
    { name: "role", isPrimary: false },
    { name: "ville", isPrimary: false },
  ];

  it("names the field a move changes places with", () => {
    expect(fieldBeside(columns, 2, -1)?.name).toBe("nom");
    expect(fieldBeside(columns, 2, 1)?.name).toBe("ville");
  });

  it("has none past the last field, or past or for the primary", () => {
    expect(fieldBeside(columns, 3, 1)).toBeUndefined();
    expect(fieldBeside(columns, 1, -1)).toBeUndefined();
    expect(fieldBeside(columns, 0, 1)).toBeUndefined();
  });

  it("moves a field to the very start of a table with no primary", () => {
    const plain = columns.map((column) => ({ ...column, isPrimary: false }));
    expect(fieldBeside(plain, 1, -1)?.name).toBe("prenom");
    expect(fieldBeside(plain, 0, -1)).toBeUndefined();
  });
});
