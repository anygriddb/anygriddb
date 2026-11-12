import { describe, expect, it } from "vitest";
import { parseFormula } from "./formula";
import { localizeTemplate } from "./template-words";
import { BASE_TEMPLATES, type BaseTemplate } from "./templates";

/** Every word a template writes, in the order it writes them. */
function wordsOf(template: BaseTemplate): string[] {
  const words: string[] = [];
  for (const table of template.tables) {
    words.push(table.name);
    for (const column of table.columns) {
      if (column.label) words.push(column.label);
      const config = column.config as
        { options?: Array<{ name: string }> } | undefined;
      for (const option of config?.options ?? []) words.push(option.name);
    }
    for (const row of table.rows ?? []) {
      for (const item of Object.values(row)) {
        for (const text of [item].flat()) {
          if (typeof text === "string") words.push(text);
        }
      }
    }
    for (const view of table.views ?? []) {
      words.push(view.name);
      const form = view.config?.form as { title?: string } | undefined;
      if (form?.title) words.push(form.title);
    }
  }
  for (const link of template.links ?? []) {
    words.push(link.label, link.inverseLabel);
  }
  for (const computed of template.computed ?? []) words.push(computed.label);
  return words;
}

/** Written the same in French: names, addresses, dates, codes, and words. */
const SAME_IN_FRENCH = new Set([
  "Contacts",
  "Email",
  "Pipeline",
  "Services",
  "Public",
  "Prospect",
  "Stock",
  "Tickets",
  "Description",
  "Acme",
  "Boreal",
  "Lyon",
  "Nantes",
  "Sète",
  "Inès Martin",
  "Paul Durand",
]);
const kept = (word: string) =>
  SAME_IN_FRENCH.has(word) ||
  /^(https:\/\/|\d{4}-\d{2}-\d{2}$)|@|^[A-Z]{3}-[A-Z0-9]{2}$/.test(word);

describe("localizeTemplate", () => {
  it.each(BASE_TEMPLATES.map((template) => [template.id, template] as const))(
    "writes %s in French, whole and consistent",
    (_, template) => {
      const french = localizeTemplate(template, "fr");
      const before = wordsOf(template);
      const after = wordsOf(french);
      expect(after).toHaveLength(before.length);
      before.forEach((word, index) => {
        const written = after[index] ?? "";
        if (!kept(word)) expect(written, word).not.toBe(word);
        // French typography: the typographic apostrophe.
        expect(written).not.toMatch(/'/);
      });
      for (const table of french.tables) {
        const refs = table.columns.map((column) => ({
          name: column.name ?? "",
          label: column.label ?? "",
        }));
        for (const column of table.columns) {
          if (column.formulaSource) {
            expect(() =>
              parseFormula(column.formulaSource ?? "", refs),
            ).not.toThrow();
          }
          const options = (
            column.config as { options?: Array<{ name: string }> } | undefined
          )?.options?.map((option) => option.name);
          if (!options || !column.name) continue;
          // A sample row's choice is one of its field's options.
          for (const row of table.rows ?? []) {
            const choice = row[column.name];
            if (typeof choice === "string") expect(options).toContain(choice);
          }
        }
      }
      // Names stay: views and rollups find what they name.
      expect(french.links?.map((link) => link.inverseName)).toEqual(
        template.links?.map((link) => link.inverseName),
      );
      expect(
        french.tables.flatMap((table) =>
          table.columns.map((column) => column.name),
        ),
      ).toEqual(
        template.tables.flatMap((table) =>
          table.columns.map((column) => column.name),
        ),
      );
    },
  );

  it("leaves a template in English as it is", () => {
    const [first] = BASE_TEMPLATES;
    if (!first) throw new Error("no template");
    expect(localizeTemplate(first, "en")).toBe(first);
  });

  it("writes one English word as a label or as a value", () => {
    const crm = BASE_TEMPLATES.find((template) => template.id === "crm");
    if (!crm) throw new Error("no CRM");
    const companies = localizeTemplate(crm, "fr").tables[0];
    const sector = companies?.columns.find(
      (column) => column.name === "secteur",
    );
    expect(sector?.label).toBe("Secteur");
    expect(
      (sector?.config as { options: Array<{ name: string }> }).options[0]?.name,
    ).toBe("Industrie");
  });
});
