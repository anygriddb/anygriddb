import { describe, expect, it } from "vitest";
import {
  airtableToSnapshot,
  type AirtableRecord,
  type AirtableTable,
} from "./airtable";
import { baseSnapshotSchema } from "./snapshot";

const tables: AirtableTable[] = [
  {
    id: "tblClients",
    name: "Clients",
    primaryFieldId: "fld1",
    fields: [
      { id: "fld1", name: "Name", type: "singleLineText" },
      { id: "fld2", name: "Email", type: "email" },
      {
        id: "fld3",
        name: "Tier",
        type: "singleSelect",
        options: {
          choices: [
            { name: "Gold", color: "yellowLight2" },
            { name: "Silver", color: "grayBright" },
          ],
        },
      },
      {
        id: "fld4",
        name: "Orders",
        type: "multipleRecordLinks",
        options: { linkedTableId: "tblOrders", inverseLinkFieldId: "fld12" },
      },
      {
        id: "fld5",
        name: "Total paid",
        type: "rollup",
        options: { result: { type: "currency" } },
      },
      {
        id: "fld6",
        name: "Order count",
        type: "count",
        options: { recordLinkFieldId: "fld4" },
      },
      { id: "fld7", name: "Logo", type: "multipleAttachments" },
      { id: "fld8", name: "Owner", type: "singleCollaborator" },
      { id: "fld9", name: "Created", type: "createdTime" },
      {
        id: "fld10",
        name: "Label {x}",
        type: "formula",
        options: { formula: "{fld1} & ' (' & {fld3} & ')'" },
      },
      {
        id: "fld11",
        name: "Odd",
        type: "formula",
        options: { formula: "LOG10(LEN({fld1}))", result: { type: "number" } },
      },
      { id: "fld13", name: "Run", type: "button" },
    ],
    views: [
      { id: "viw1", name: "Grid view", type: "grid" },
      { id: "viw2", name: "Par niveau", type: "kanban" },
      { id: "viw3", name: "Board", type: "block" },
    ],
  },
  {
    id: "tblOrders",
    name: "Orders / 2026",
    primaryFieldId: "fld20",
    fields: [
      { id: "fld20", name: "Ref", type: "singleLineText" },
      {
        id: "fld21",
        name: "Amount",
        type: "currency",
        options: { symbol: "$", precision: 2 },
      },
      { id: "fld22", name: "Paid", type: "checkbox" },
      { id: "fld23", name: "Share", type: "percent" },
      {
        id: "fld12",
        name: "Client",
        type: "multipleRecordLinks",
        options: {
          linkedTableId: "tblClients",
          inverseLinkFieldId: "fld4",
          prefersSingleRecordLink: true,
        },
      },
      {
        id: "fld24",
        name: "Client tier",
        type: "multipleLookupValues",
        options: { recordLinkFieldId: "fld12", fieldIdInLinkedTable: "fld3" },
      },
      { id: "fld25", name: "Due", type: "date" },
      {
        id: "fld26",
        name: "Tags",
        type: "multipleSelects",
        options: { choices: [{ name: "x" }, { name: "y" }] },
      },
    ],
    views: [{ id: "viw4", name: "Échéances", type: "calendar" }],
  },
];

const records = new Map<string, AirtableRecord[]>([
  [
    "tblClients",
    [
      {
        id: "rec1",
        fields: {
          fld1: "Acme",
          fld2: "a@acme.test",
          fld3: "Gold",
          fld4: ["recA", "recB"],
          fld5: 150,
          fld6: 2,
          fld7: [{ filename: "logo.png", url: "https://dl.example/logo.png" }],
          fld8: { id: "usr1", email: "ana@acme.test", name: "Ana" },
          fld9: "2025-01-02T03:04:05.000Z",
          fld10: "Acme (Gold)",
          fld11: 0.6,
        },
      },
      { id: "rec2", fields: { fld1: "Beta" } },
    ],
  ],
  [
    "tblOrders",
    [
      {
        id: "recA",
        fields: {
          fld20: "A-1",
          fld21: 100,
          fld22: true,
          fld23: 0.25,
          fld12: ["rec1"],
          fld25: "2026-03-01",
          fld26: ["x", "y"],
        },
      },
      { id: "recB", fields: { fld20: "A-2", fld21: 50.5, fld12: ["rec1"] } },
    ],
  ],
]);

describe("airtableToSnapshot", () => {
  const { snapshot, report } = airtableToSnapshot({
    name: "Ventes (Airtable)",
    tables,
    records,
  });

  it("builds a snapshot the import accepts", () => {
    expect(() => baseSnapshotSchema.parse(snapshot)).not.toThrow();
    expect(snapshot.base.name).toBe("Ventes (Airtable)");
    expect(snapshot.tables.map((table) => table.name)).toEqual([
      "Clients",
      "Orders / 2026",
    ]);
  });

  it("makes one two-way link per pair, with its rows", () => {
    expect(snapshot.links).toEqual([
      {
        from: "t1",
        to: "t2",
        name: "orders",
        label: "Orders",
        inverseLabel: "Client",
        inverseName: "client",
        twoWay: true,
        multiple: true,
        links: [{ from: "rec1", to: ["recA", "recB"] }],
      },
    ]);
  });

  it("keeps lookups and counts computed, and formulas it can read", () => {
    expect(snapshot.computed).toEqual([
      {
        table: "t1",
        name: "order_count",
        label: "Order count",
        relation: "orders",
        target: "ref",
        fn: "count",
      },
      {
        table: "t2",
        name: "client_tier",
        label: "Client tier",
        relation: "client",
        target: "tier",
      },
    ]);
    const clients = snapshot.tables[0];
    const formula = clients?.columns.find(
      (column) => column.label === "Label x",
    );
    expect(formula).toMatchObject({
      fieldType: "formula",
      formulaSource: "{Name} & ' (' & {Tier} & ')'",
    });
    expect(clients?.columns.at(-1)?.fieldType).toBe("formula");
    expect(
      clients?.columns.find((column) => column.label === "Odd")?.fieldType,
    ).toBe("number");
    expect(clients?.columns.some((column) => column.label === "Run")).toBe(
      false,
    );
  });

  it("converts each value", () => {
    const [clients, orders] = snapshot.tables;
    expect(clients?.rows?.[0]).toMatchObject({
      __id: "rec1",
      name: "Acme",
      tier: "Gold",
      total_paid: 150,
      logo: "logo.png",
      owner: "Ana <ana@acme.test>",
      created: "2025-01-02T03:04:05.000Z",
      odd: 0.6,
    });
    expect(orders?.rows?.[0]).toMatchObject({
      amount: 100,
      paid: true,
      share: 25,
      due: "2026-03-01",
      tags: ["x", "y"],
    });
    expect(orders?.rows?.[1]).toMatchObject({ paid: false });
    expect(
      orders?.columns.find((column) => column.name === "amount")?.config,
    ).toEqual({
      number: { precision: 2, style: "currency", currency: "USD" },
    });
    expect(
      clients?.columns.find((column) => column.name === "tier")?.config,
    ).toEqual({
      options: [
        { name: "Gold", color: "yellow" },
        { name: "Silver", color: "gray" },
      ],
    });
    expect(clients?.primary).toBe("name");
    expect(orders?.views).toEqual([
      { name: "Échéances", viewType: "calendar" },
    ]);
  });

  it("names what did not come over as it was", () => {
    const notes = report.map(
      (item) => `${item.field ?? item.view ?? "-"}:${item.note}`,
    );
    expect(notes).toEqual(
      expect.arrayContaining([
        "Total paid:rollup_as_values",
        "Logo:attachments_as_names",
        "Owner:people_as_text",
        "Created:system_as_values",
        "Odd:formula_as_values",
        "Run:button_skipped",
        "Board:view_skipped",
        "-:view_settings",
      ]),
    );
  });
});
