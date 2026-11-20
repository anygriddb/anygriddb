import { describe, expect, it } from "vitest";
import { parseColumnConfig } from "./field-config";
import { parseFormula } from "./formula";
import { deriveColumnName } from "./names";
import { columnDefinitionSchema } from "./schemas";
import { BASE_TEMPLATES, findTemplate, templateOn } from "./templates";
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

describe("a template's sample dates", () => {
  const named = (id: string) => {
    const template = findTemplate(id);
    if (!template) throw new Error(`no template ${id}`);
    return template;
  };
  const rowsOf = (id: string, table: string, on: Date) =>
    templateOn(named(id), on).tables.find((item) => item.key === table)?.rows ??
    [];

  it("are counted from the day the base is made, none written as a date", () => {
    for (const template of BASE_TEMPLATES) {
      for (const table of template.tables) {
        const dated = table.columns
          .filter(
            (column) =>
              column.fieldType === "date" || column.fieldType === "datetime",
          )
          .map((column) => column.name ?? "");
        for (const row of table.rows ?? []) {
          for (const name of dated) {
            const value = row[name];
            // A date of its own would be stale a few months on.
            expect(
              value === undefined ||
                value === null ||
                typeof value === "object",
              `${template.id}.${table.key}.${name}`,
            ).toBe(true);
          }
        }
      }
    }
  });

  it("become dates and instants of that day's calendar", () => {
    // The end of a February in a leap year, and of a year.
    const deals = rowsOf("crm", "deals", new Date("2028-02-27T22:00:00Z"));
    expect(deals.map((row) => row.cloture)).toEqual([
      "2028-03-02",
      "2028-04-02",
      "2028-02-07",
    ]);
    const sessions = rowsOf(
      "events",
      "sessions",
      new Date("2026-12-30T10:00:00Z"),
    );
    expect(sessions.map((row) => [row.debut, row.fin])).toEqual([
      ["2026-12-31T08:30:00.000Z", "2026-12-31T09:30:00.000Z"],
      ["2026-12-31T13:00:00.000Z", "2026-12-31T16:00:00.000Z"],
      ["2027-01-01T15:00:00.000Z", "2027-01-01T16:00:00.000Z"],
    ]);
    // What is not a day stays as written.
    expect(deals[0]).toMatchObject({
      titre: "Production line",
      montant: 48000,
    });
  });

  it("put what a calendar shows first on the page it opens", () => {
    // A calendar opens on today's month and shows six weeks: whatever
    // the day, the five days after it are on that page.
    const shown = (id: string, table: string, field: string) =>
      (findTemplate(id)?.tables.find((item) => item.key === table)?.rows ?? [])
        .map((row) => row[field])
        .filter(
          (value): value is { day: number } =>
            typeof value === "object" && value !== null && "day" in value,
        )
        .some((value) => value.day >= 0 && value.day <= 5);
    expect(shown("events", "sessions", "debut")).toBe(true);
    expect(shown("crm", "deals", "cloture")).toBe(true);
  });

  it("leave a project under way and a task late, as a team finds them", () => {
    const [redesign] = rowsOf("projects", "projects", new Date("2026-06-15"));
    expect(redesign).toMatchObject({ debut: "2026-05-28", fin: "2026-07-13" });
  });
});
