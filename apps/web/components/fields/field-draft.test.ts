import { describe, expect, it } from "vitest";
import type { CatalogColumn, CatalogTable } from "../../lib/types";
import {
  codeAppearance,
  configOf,
  convertsValues,
  draftOf,
  fieldRequest,
  formulaConfigOf,
  moveOption,
  typesOffered,
  type FieldDraft,
} from "./field-draft";

function column(partial: Partial<CatalogColumn>): CatalogColumn {
  return {
    id: "c1",
    name: "field",
    label: "Field",
    description: null,
    fieldType: "text",
    kind: "text",
    isPrimary: false,
    isUnique: false,
    required: false,
    requireReason: false,
    controlPlane: false,
    config: {},
    relation: null,
    formulaSource: null,
    limits: [],
    ...partial,
  } as CatalogColumn;
}

function tableOf(partial: Partial<CatalogTable> = {}): CatalogTable {
  return {
    id: "t1",
    name: "Samples",
    external: null,
    columns: [],
    ...partial,
  } as CatalogTable;
}

const table = tableOf();
const other = tableOf({ id: "t2", name: "Projects" });
const tables = [table, other];
const fresh = (change: Partial<FieldDraft> = {}): FieldDraft => ({
  ...draftOf(null, table, tables),
  ...change,
});

describe("draftOf", () => {
  it("opens a new field as a text, its links reaching another table", () => {
    const draft = draftOf(null, table, tables);
    expect(draft).toMatchObject({
      label: "",
      fieldType: "text",
      currency: "EUR",
      dateFormat: "eu",
      ratingMax: "5",
      notify: true,
      linkTable: "t2",
      linkMultiple: true,
      twoWay: true,
    });
    // A client's table takes a computed field first.
    const client = tableOf({ external: {} as CatalogTable["external"] });
    expect(draftOf(null, client, [client]).fieldType).toBe("formula");
    // With no other table, a link reaches its own.
    expect(draftOf(null, table, [table]).linkTable).toBe("t1");
  });

  it("opens a field with what it holds", () => {
    const draft = draftOf(
      column({
        label: "Price",
        fieldType: "number",
        isUnique: true,
        requireReason: true,
        config: {
          number: { precision: 2, style: "currency", currency: "USD" },
          nonNegative: true,
        },
      }),
      table,
      tables,
    );
    expect(draft).toMatchObject({
      label: "Price",
      fieldType: "number",
      unique: true,
      requireReason: true,
      precision: "2",
      numberStyle: "currency",
      currency: "USD",
      nonNegative: true,
    });
    // A link, whichever its kind, opens as a link; an option keeps the
    // name it was stored under.
    expect(
      draftOf(column({ fieldType: "relation_many_to_many" }), table, tables)
        .fieldType,
    ).toBe("link");
    expect(
      draftOf(
        column({
          fieldType: "single_select",
          config: { options: [{ name: "Open", color: "gray" }] },
        }),
        table,
        tables,
      ).options,
    ).toEqual([{ name: "Open", color: "gray", original: "Open", id: "Open" }]);
  });
});

describe("typesOffered", () => {
  it("offers every type for a new field of AnyGridDB's own table", () => {
    const types = typesOffered(null, table);
    expect(types).toEqual(
      expect.arrayContaining(["text", "number", "link", "formula", "button"]),
    );
  });

  it("offers a client's table computed fields, and stored ones only beside it", () => {
    const closed = tableOf({
      external: { enrichable: false } as CatalogTable["external"],
    });
    expect(typesOffered(null, closed).sort()).toEqual(
      ["button", "formula", "lookup", "rollup", "row_id"].sort(),
    );
    const open = tableOf({
      external: { enrichable: true } as CatalogTable["external"],
    });
    expect(typesOffered(null, open)).toContain("text");
    expect(typesOffered(null, open)).not.toContain("link");
  });

  it("keeps a field's type, or offers those its values convert to", () => {
    expect(typesOffered(column({ fieldType: "text" }), table)).toEqual(
      expect.arrayContaining(["text", "number", "date", "single_select"]),
    );
    expect(typesOffered(column({ fieldType: "text" }), table)).not.toContain(
      "formula",
    );
    expect(typesOffered(column({ fieldType: "formula" }), table)).toEqual([
      "formula",
    ]);
    expect(
      typesOffered(column({ fieldType: "relation_one_to_many" }), table),
    ).toEqual(["link"]);
    expect(typesOffered(column({ fieldType: "user" }), table)).toEqual([
      "user",
    ]);
  });
});

describe("configOf", () => {
  it("keeps the named options, trimmed, and how the list is drawn", () => {
    expect(
      configOf(
        fresh({
          fieldType: "single_select",
          appearance: "radio",
          options: [
            { name: " Open ", color: "gray" },
            { name: "  ", color: "red" },
          ],
        }),
        {},
      ),
    ).toEqual({
      options: [{ name: "Open", color: "gray" }],
      appearance: "radio",
    });
    // A way of drawing that another type has is not kept.
    expect(
      configOf(fresh({ fieldType: "multi_select", appearance: "radio" }), {}),
    ).toEqual({ options: [] });
  });

  it("writes a number's format, with its currency only as money", () => {
    expect(
      configOf(
        fresh({
          fieldType: "number",
          numberStyle: "currency",
          precision: "2",
          currency: "USD",
          nonNegative: true,
        }),
        {},
      ),
    ).toEqual({
      number: { precision: 2, style: "currency", currency: "USD" },
      nonNegative: true,
    });
    expect(configOf(fresh({ fieldType: "number" }), {})).toEqual({
      number: { style: "decimal" },
    });
  });

  it("writes a rating, people, a button, a date, and a duration", () => {
    expect(
      configOf(
        fresh({
          fieldType: "rating",
          ratingMax: "3",
          ratingIcon: "heart",
          ratingColor: "red",
        }),
        {},
      ),
    ).toEqual({ ratingMax: 3, ratingIcon: "heart", ratingColor: "red" });
    expect(configOf(fresh({ fieldType: "rating" }), {})).toEqual({
      ratingMax: 5,
    });
    expect(
      configOf(fresh({ fieldType: "user", multiple: true, notify: false }), {}),
    ).toEqual({ multiple: true, notify: false });
    expect(
      configOf(
        fresh({
          fieldType: "button",
          label: "Go",
          buttonUrl: " https://example.org/{{record_id}} ",
        }),
        {},
      ),
    ).toEqual({
      button: {
        label: "Go",
        color: "blue",
        action: "open_url",
        url: "https://example.org/{{record_id}}",
      },
    });
    expect(
      configOf(
        fresh({ fieldType: "button", buttonAction: "run_automation" }),
        {},
      ).button,
    ).toEqual({ label: "Action", color: "blue", action: "run_automation" });
    expect(
      configOf(fresh({ fieldType: "date", dateFormat: "iso" }), {}),
    ).toEqual({ date: { format: "iso" } });
    expect(
      configOf(fresh({ fieldType: "duration", durationFormat: "h:mm:ss" }), {}),
    ).toEqual({ durationFormat: "h:mm:ss" });
  });

  it("keeps a text's default, and draws a code only where a field holds one", () => {
    expect(
      configOf(fresh({ fieldType: "text", appearance: "qr" }), {
        defaultValue: "n/a",
      }),
    ).toEqual({ defaultValue: "n/a", appearance: "qr" });
    expect(
      codeAppearance(fresh({ fieldType: "number", appearance: "qr" })),
    ).toBeNull();
    expect(configOf(fresh({ fieldType: "long_text" }), {})).toEqual({});
  });
});

describe("moveOption", () => {
  const options = [
    { name: "Open", color: "gray" },
    { name: "Waiting", color: "red" },
    { name: "Closed", color: "green" },
  ];
  const names = (list: Array<{ name: string }>) =>
    list.map((item) => item.name);

  it("moves an option a place up or down", () => {
    expect(names(moveOption(options, 2, -1))).toEqual([
      "Open",
      "Closed",
      "Waiting",
    ]);
    expect(names(moveOption(options, 0, 1))).toEqual([
      "Waiting",
      "Open",
      "Closed",
    ]);
  });

  it("leaves the order as it is past either end", () => {
    expect(names(moveOption(options, 0, -1))).toEqual(names(options));
    expect(names(moveOption(options, 2, 1))).toEqual(names(options));
    expect(names(moveOption(options, 7, -1))).toEqual(names(options));
  });
});

describe("formulaConfigOf", () => {
  it("sends a formula's code with the formats it had, or nothing at all", () => {
    const formula = fresh({ fieldType: "formula", appearance: "barcode" });
    expect(formulaConfigOf(formula, { number: { precision: 1 } })).toEqual({
      number: { precision: 1 },
      appearance: "barcode",
    });
    // A code taken away is sent too: the formats alone.
    expect(
      formulaConfigOf(fresh({ fieldType: "formula" }), { appearance: "qr" }),
    ).toEqual({});
    expect(
      formulaConfigOf(fresh({ fieldType: "formula" }), {}),
    ).toBeUndefined();
  });
});

describe("convertsValues", () => {
  it("asks first when a type changes between two that convert", () => {
    expect(
      convertsValues(
        fresh({ fieldType: "number" }),
        column({ fieldType: "text" }),
      ),
    ).toBe(true);
  });

  it("does not for a new field, the same type, or a link", () => {
    expect(convertsValues(fresh({ fieldType: "number" }), null)).toBe(false);
    expect(
      convertsValues(
        fresh({ fieldType: "text" }),
        column({ fieldType: "text" }),
      ),
    ).toBe(false);
    expect(
      convertsValues(
        fresh({ fieldType: "link" }),
        column({ fieldType: "relation_many_to_many" }),
      ),
    ).toBe(false);
  });
});

describe("fieldRequest", () => {
  it("makes a link, a lookup, and a rollup by their own calls", () => {
    expect(
      fieldRequest(
        fresh({ fieldType: "link", label: " Project ", linkMultiple: false }),
        { mode: "create" },
        table,
      ),
    ).toEqual({
      call: "addRelation",
      input: {
        tableId: "t1",
        label: "Project",
        kind: "one_to_many",
        targetTableId: "t2",
        twoWay: true,
      },
    });
    // A link to its own table has no field that leads back.
    expect(
      fieldRequest(
        fresh({ fieldType: "link", linkTable: "t1" }),
        { mode: "create" },
        table,
      ),
    ).toMatchObject({ input: { label: undefined, twoWay: false } });
    expect(
      fieldRequest(
        fresh({
          fieldType: "lookup",
          relation: "project",
          targetColumn: "name",
        }),
        { mode: "create" },
        table,
      ),
    ).toEqual({
      call: "addLookup",
      input: {
        tableId: "t1",
        label: undefined,
        relation: "project",
        target: "name",
        filter: undefined,
      },
    });
    const condition = {
      conjunction: "and" as const,
      conditions: [{ column: "name", op: "is" as const, value: "Apollo" }],
    };
    expect(
      fieldRequest(
        fresh({
          fieldType: "rollup",
          relation: "project",
          targetColumn: "name",
          rollupFn: "counta",
          linkedFilter: condition,
        }),
        { mode: "create" },
        table,
      ),
    ).toMatchObject({
      call: "addRollup",
      input: { fn: "counta", filter: condition },
    });
  });

  it("adds any other field with its settings, where it was asked for", () => {
    expect(
      fieldRequest(
        fresh({
          fieldType: "text",
          label: "Ref",
          unique: true,
          primary: true,
          description: "A reference",
        }),
        { mode: "create", position: 2 },
        table,
      ),
    ).toEqual({
      call: "addColumn",
      input: {
        tableId: "t1",
        position: 2,
        column: {
          label: "Ref",
          fieldType: "text",
          description: "A reference",
          requireReason: false,
          required: false,
          unique: true,
          config: {},
          formulaSource: undefined,
        },
      },
      makePrimary: true,
    });
    // A client's table says itself what it requires and what is unique.
    const client = tableOf({ external: {} as CatalogTable["external"] });
    expect(
      fieldRequest(
        fresh({
          fieldType: "text",
          label: "Ref",
          unique: true,
          required: true,
        }),
        { mode: "create" },
        client,
      ),
    ).toMatchObject({
      input: { column: { unique: undefined, required: undefined } },
    });
    // A checkbox cannot name a row.
    expect(
      fieldRequest(
        fresh({ fieldType: "boolean", label: "Ok", primary: true }),
        { mode: "create" },
        table,
      ),
    ).toMatchObject({ makePrimary: false });
  });

  it("changes a field: its renamed options, its new type, its place as primary", () => {
    const editing = column({
      name: "stage",
      label: "Stage",
      fieldType: "single_select",
      config: { options: [{ name: "Open", color: "gray" }] },
    });
    const draft = draftOf(editing, table, tables);
    const first = draft.options[0];
    expect(
      fieldRequest(
        {
          ...draft,
          options: first ? [{ ...first, name: "Opened" }] : [],
          primary: true,
        },
        { mode: "edit", column: editing },
        table,
      ),
    ).toEqual({
      call: "updateColumn",
      input: {
        tableId: "t1",
        name: "stage",
        label: "Stage",
        description: null,
        requireReason: false,
        required: false,
        unique: false,
        fieldType: undefined,
        config: { options: [{ name: "Opened", color: "gray" }] },
        formulaSource: undefined,
        optionRenames: [{ from: "Open", to: "Opened" }],
      },
      makePrimary: true,
    });
    expect(
      fieldRequest(
        { ...draft, fieldType: "text" },
        { mode: "edit", column: editing },
        table,
      ),
    ).toMatchObject({
      input: { fieldType: "text", config: {}, optionRenames: undefined },
      makePrimary: false,
    });
  });

  it("sends a link its selection only, and a lookup its condition only", () => {
    const link = column({
      name: "project",
      fieldType: "relation_many_to_many",
    });
    expect(
      fieldRequest(
        draftOf(link, table, tables),
        { mode: "edit", column: link },
        table,
      ),
    ).toMatchObject({ input: { fieldType: undefined, config: {} } });
    const lookup = column({
      name: "project_name",
      fieldType: "lookup",
      config: { relation: "project", target: "name" },
    });
    expect(
      fieldRequest(
        draftOf(lookup, table, tables),
        { mode: "edit", column: lookup },
        table,
      ),
    ).toMatchObject({ input: { config: {} } });
  });
});
