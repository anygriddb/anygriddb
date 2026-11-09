import { describe, expect, it } from "vitest";
import { linkedRowDraft, linkTarget } from "./link-actions";

const link = {
  name: "company",
  fieldType: "relation_many_to_many",
  config: {},
  relation: { targetTableId: "t-companies" },
} as never;

function table(overrides: Record<string, unknown> = {}) {
  return {
    id: "t-companies",
    role: "editor",
    external: null,
    columns: [
      {
        name: "name",
        fieldType: "text",
        config: {},
        isPrimary: true,
        access: "write",
        error: null,
      },
    ],
    ...overrides,
  } as never;
}

describe("link actions", () => {
  it("drafts a row in the other table from the typed text", () => {
    expect(linkTarget(link, [table()])).toMatchObject({ id: "t-companies" });
    expect(linkedRowDraft(link, [table()], "  Acme  ")).toEqual({
      tableId: "t-companies",
      values: { name: "Acme" },
    });
  });

  it("refuses a field limited to a view or a filter", () => {
    const limited = {
      ...(link as object),
      config: { selectFrom: { view: "v-active" } },
    } as never;
    expect(linkedRowDraft(limited, [table()], "Acme")).toBeUndefined();
  });

  it("refuses a client's table, a reader, and a primary that is computed", () => {
    expect(linkedRowDraft(link, [table()], "   ")).toBeUndefined();
    expect(linkedRowDraft(link, [], "Acme")).toBeUndefined();
    expect(
      linkedRowDraft(link, [table({ role: "viewer" })], "Acme"),
    ).toBeUndefined();
    expect(
      linkedRowDraft(link, [table({ external: { writes: {} } })], "Acme"),
    ).toBeUndefined();
    const computed = table({
      columns: [
        {
          name: "label",
          fieldType: "formula",
          config: {},
          isPrimary: true,
          access: "write",
          error: null,
        },
      ],
    });
    expect(linkedRowDraft(link, [computed], "Acme")).toBeUndefined();
  });
});
