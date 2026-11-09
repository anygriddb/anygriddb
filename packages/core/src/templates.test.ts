import { describe, expect, it } from "vitest";
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
      }
      for (const computed of template.computed ?? []) {
        // Rollups run over the inverse column of a link into their table.
        const inverse = (template.links ?? []).find(
          (link) =>
            link.to === computed.table &&
            deriveColumnName(link.inverseLabel, new Set()) ===
              computed.relation,
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

  it("finds templates by id and nothing else", () => {
    expect(findTemplate("crm")?.name).toBe("CRM");
    expect(findTemplate("unknown")).toBeUndefined();
  });
});
