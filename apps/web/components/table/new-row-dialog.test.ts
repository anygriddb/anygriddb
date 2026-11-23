import { describe, expect, it } from "vitest";
import type { CatalogColumn } from "../../lib/types";
import { newRowFields } from "./new-row-dialog";

function column(name: string, more: Record<string, unknown>): CatalogColumn {
  return {
    name,
    label: name,
    fieldType: "text",
    insertable: true,
    error: null,
    ...more,
  } as unknown as CatalogColumn;
}

const must = column("must", {});
const link = column("lnk", {
  fieldType: "relation_one_to_many",
  relation: { kind: "one_to_many", direction: "forward" },
});
const back = column("back", {
  fieldType: "relation_one_to_many",
  relation: { kind: "one_to_many", direction: "backward" },
});
const total = column("total", { fieldType: "formula" });

describe("newRowFields", () => {
  it("offers a client's table the key its new row holds", () => {
    expect(
      newRowFields([must, link, back, total], true).map((item) => item.name),
    ).toEqual(["must", "lnk"]);
  });

  it("offers a table of AnyGridDB's own no link: one is set on a row that exists", () => {
    expect(
      newRowFields([must, link, back, total], false).map((item) => item.name),
    ).toEqual(["must"]);
  });
});
