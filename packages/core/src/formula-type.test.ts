import { describe, expect, it } from "vitest";
import { checkFormulaTyped, typeFormula } from "./formula-type";
import type { FormulaTypeColumn } from "./formula-type";

const columns: FormulaTypeColumn[] = [
  { id: "1", name: "title", label: "Title", fieldType: "text", config: {} },
  { id: "2", name: "price", label: "Price", fieldType: "number", config: {} },
  { id: "3", name: "qty", label: "Qty", fieldType: "number", config: {} },
  { id: "4", name: "due", label: "Due", fieldType: "date", config: {} },
];

const refs = columns.map(({ name, label }) => ({ name, label }));

const ctx = {
  tableId: "00000000-0000-4000-8000-000000000099",
  columns,
};

describe("typeFormula", () => {
  it("accepts a typed arithmetic formula and reports its kind", () => {
    const typed = typeFormula("{Price} * {Qty}", refs, ctx);
    expect(typed).toMatchObject({ kind: "number", limits: [] });
  });

  it("rejects a type error the parser alone would accept", () => {
    const problem = checkFormulaTyped("DATE_ADD({Due}, 1, {Title})", refs, ctx);
    expect(problem?.code).toMatch(/invalid_(arguments|formula|unit)/);
  });

  it("refuses to read a field kept in AnyGridDB for a client's table", () => {
    const note: FormulaTypeColumn = {
      id: "5",
      name: "note",
      label: "Note",
      fieldType: "text",
      config: {},
      controlPlane: true,
    };
    const problem = checkFormulaTyped(
      "{Title} & {Note}",
      [...refs, { name: "note", label: "Note" }],
      { ...ctx, columns: [...columns, note], engine: "mysql" },
    );
    expect(problem?.code).toBe("control_plane_formula");
    expect(
      checkFormulaTyped("{Title}", refs, {
        ...ctx,
        columns: [...columns, note],
      }),
    ).toBeNull();
  });

  it("rejects an unknown field with a span from the parser", () => {
    const problem = checkFormulaTyped("{Missing}", refs, ctx);
    expect(problem?.code).toBe("unknown_field");
    expect(problem?.from).toBeGreaterThanOrEqual(0);
  });

  it("marks approximate functions on MySQL", () => {
    const typed = typeFormula("SQRT({Price})", refs, {
      ...ctx,
      engine: "mysql",
    });
    expect(typed).toMatchObject({ kind: "number" });
    if ("limits" in typed) {
      expect(typed.limits.some((limit) => limit.fn === "SQRT")).toBe(true);
    }
  });
});
