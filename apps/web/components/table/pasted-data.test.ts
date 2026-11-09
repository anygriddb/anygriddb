import { describe, expect, it } from "vitest";
import { pastedFile } from "./pasted-data";

describe("pasted data", () => {
  it("reads a spreadsheet's copy as TSV and loose text as CSV", async () => {
    const tsv = pastedFile("\nNom\tMontant\nAcme\t12,5\n\n", "Collé");
    expect(tsv?.name).toBe("Collé.tsv");
    expect(tsv?.type).toBe("text/tab-separated-values");
    expect(await tsv?.text()).toBe("Nom\tMontant\nAcme\t12,5\n");
    expect(pastedFile("Nom,Ville\nAcme,Lyon", "Collé")?.name).toBe("Collé.csv");
  });

  it("refuses an empty paste", () => {
    expect(pastedFile("  \n \n", "Collé")).toBeUndefined();
  });
});
