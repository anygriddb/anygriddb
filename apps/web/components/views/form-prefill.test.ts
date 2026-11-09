import { describe, expect, it } from "vitest";
import { formPrefill } from "./form-prefill";

const columns = [
  { name: "nom", label: "Nom", fieldType: "text", config: {} },
  {
    name: "statut",
    label: "Statut",
    fieldType: "single_select",
    config: { options: [{ name: "Ouvert" }, { name: "Fermé" }] },
  },
  {
    name: "tags",
    label: "Étiquettes",
    fieldType: "multi_select",
    config: { options: [{ name: "Urgent" }, { name: "Client" }] },
  },
  { name: "valide", label: "Validé", fieldType: "boolean", config: {} },
  { name: "source", label: "Source", fieldType: "text", config: {} },
] as never[];

describe("form prefill", () => {
  it("fills fields by name or label and hides the filled ones asked", () => {
    const { values, hidden } = formPrefill(
      "?prefill_nom=Acme&prefill_Statut=ouvert&prefill_%C3%89tiquettes=urgent,Client,nope" +
        "&prefill_valide=oui&prefill_source=site&hide_source=true",
      columns,
    );
    expect(values).toEqual({
      nom: "Acme",
      statut: "Ouvert",
      tags: ["Urgent", "Client"],
      valide: true,
      source: "site",
    });
    expect([...hidden]).toEqual(["source"]);
  });

  it("ignores fields outside the form, values that do not fit, and bare hides", () => {
    const { values, hidden } = formPrefill(
      "?prefill_secret=1&prefill_statut=Inconnu&prefill_valide=peut-etre&hide_nom=true&row=7",
      columns,
    );
    expect(values).toEqual({});
    expect(hidden.size).toBe(0);
  });
});
