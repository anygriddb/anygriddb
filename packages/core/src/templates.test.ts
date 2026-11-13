import { describe, expect, it } from "vitest";
import { parseColumnConfig } from "./field-config";
import { parseFormula } from "./formula";
import { deriveColumnName } from "./names";
import { columnDefinitionSchema } from "./schemas";
import { BASE_TEMPLATES, findTemplate } from "./templates";
import { viewConfigSchema } from "./view-config";

describe("BASE_TEMPLATES", () => {
  it.each(BASE_TEMPLATES.map((template) => [template.id, template] as const))(
    "%s is consistent",
    (_, template) => {
      const keys = new Set(template.tables.map((table) => table.key));
      for (const table of template.tables) {
        const names = new Set(table.columns.map((column) => column.name));
        for (const column of table.columns) {
          expect(columnDefinitionSchema.safeParse(column).success).toBe(true);
          if (column.formulaSource) {
            const refs = table.columns.map((item) => ({
              name: item.name ?? "",
              label: item.label ?? "",
            }));
            expect(() =>
              parseFormula(column.formulaSource ?? "", refs),
            ).not.toThrow();
            // Its display settings are ones a formula field keeps.
            expect(() =>
              parseColumnConfig("formula", {
                ...column.config,
                expr: parseFormula(column.formulaSource ?? "", refs),
              }),
            ).not.toThrow();
          }
        }
        for (const row of table.rows ?? []) {
          for (const key of Object.keys(row)) expect(names.has(key)).toBe(true);
        }
        for (const view of table.views ?? []) {
          expect(viewConfigSchema.safeParse(view.config ?? {}).success).toBe(
            true,
          );
        }
      }
      for (const link of template.links ?? []) {
        expect(keys.has(link.from) && keys.has(link.to)).toBe(true);
        // Names a column can have, kept as they are.
        for (const name of [link.name, link.inverseName]) {
          expect(deriveColumnName(name, new Set())).toBe(name);
        }
      }
      for (const computed of template.computed ?? []) {
        // Rollups run over the inverse column of a link into their table.
        const inverse = (template.links ?? []).find(
          (link) =>
            link.to === computed.table &&
            link.inverseName === computed.relation,
        );
        expect(inverse).toBeDefined();
        const source = template.tables.find(
          (table) => table.key === inverse?.from,
        );
        expect(
          source?.columns.some((column) => column.name === computed.target),
        ).toBe(true);
      }
    },
  );

  it("writes money computed from money as money", () => {
    const money = (template: string, table: string, column: string) =>
      findTemplate(template)
        ?.tables.find((item) => item.key === table)
        ?.columns.find((item) => item.name === column)?.config;
    expect(money("crm", "deals", "pondere")).toMatchObject({
      number: { style: "currency", currency: "EUR" },
    });
    expect(money("inventory", "products", "valeur")).toMatchObject({
      number: { style: "currency", currency: "EUR" },
    });
    // A yes/no formula keeps no number format.
    expect(money("inventory", "products", "a_commander")).toBeUndefined();
  });

  it("finds templates by id and nothing else", () => {
    expect(findTemplate("crm")?.name).toBe("CRM");
    expect(findTemplate("unknown")).toBeUndefined();
  });
});
