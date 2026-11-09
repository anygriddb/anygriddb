import { describe, expect, it } from "vitest";
import type { EngineColumn, EngineTable } from "./engine";
import { sealDrift, sealedFields, sealRow, sealText, sealValue } from "./seal";

function column(
  name: string,
  fieldType: string,
  extra: Partial<EngineColumn> = {},
): EngineColumn {
  return {
    id: name,
    name,
    label: name,
    fieldType,
    physical: { name, type: "text" },
    ...extra,
  } as EngineColumn;
}

const table = {
  id: "t",
  columns: [
    column("amount", "number"),
    column("label", "text"),
    column("code", "text"),
    column("customer", "relation_one_to_many", {
      relation: { direction: "forward", kind: "one_to_many" },
    } as Partial<EngineColumn>),
    column("orders", "relation_one_to_many", {
      physical: undefined,
      relation: { direction: "inverse", kind: "one_to_many" },
    } as Partial<EngineColumn>),
    column("total", "formula", { physical: undefined }),
    column("note", "long_text", {
      physical: { name: "ag_note", type: "text", side: true },
    } as Partial<EngineColumn>),
  ],
} as unknown as EngineTable;

describe("seals of client rows", () => {
  it("seals what a row stores, not what follows other rows", () => {
    expect(sealedFields(table).map((item) => item.name)).toEqual([
      "amount",
      "label",
      "code",
      "customer",
      "note",
    ]);
  });

  it("writes numbers canonical, text exactly, links as their key", () => {
    const number = column("n", "number");
    expect(sealValue(number, "10.50")).toBe("10.5");
    expect(sealValue(number, 10.5)).toBe("10.5");
    expect(sealValue(number, "-0.00")).toBe("0");
    // Leading zeros of a code are its value: text is kept exactly.
    expect(sealValue(column("code", "text"), "01234")).toBe("01234");
    const link = table.columns[3] as EngineColumn;
    expect(sealValue(link, [{ id: 7, label: "Acme" }])).toBe("7");
    expect(sealValue(link, [])).toBeNull();
    expect(sealValue(number, undefined)).toBeNull();
  });

  it("hashes the same text whatever order the fields came in", () => {
    const row = sealRow(table, {
      label: "A",
      amount: "10.50",
      code: "01",
      customer: [{ id: "7", label: "Acme" }],
      total: "999",
      note: null,
    });
    expect(row).toEqual({
      amount: "10.5",
      label: "A",
      code: "01",
      customer: "7",
      note: null,
    });
    expect(sealText(row)).toBe(
      '[["amount","10.5"],["code","01"],["customer","7"],["label","A"],["note",null]]',
    );
    expect(sealText({ b: 1, a: 2 })).toBe(sealText({ a: 2, b: 1 }));
  });

  it("names the fields that moved, ignoring those no longer exposed", () => {
    const sealed = { amount: "10.5", label: "A", gone: "x" };
    expect(sealDrift(sealed, { amount: "10.5", label: "A" })).toEqual([]);
    expect(sealDrift(sealed, { amount: "11", label: "B" })).toEqual([
      "amount",
      "label",
    ]);
    expect(sealDrift(sealed, { amount: "10.5", label: null })).toEqual([
      "label",
    ]);
  });
});
