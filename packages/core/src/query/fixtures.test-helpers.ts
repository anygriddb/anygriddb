import type { EngineCatalog, EngineTable } from "./engine";

export const ORDERS_ID = "00000000-0000-4000-8000-000000000001";
export const CLIENTS_ID = "00000000-0000-4000-8000-000000000002";
export const SECRET_ID = "00000000-0000-4000-8000-000000000003";

export const clients: EngineTable = {
  id: CLIENTS_ID,
  storage: "native",
  physicalName: "t_clients",
  primaryColumn: "name",
  columns: [
    { id: "c1", name: "name", label: "Name", fieldType: "text", config: {} },
    { id: "c2", name: "city", label: "City", fieldType: "text", config: {} },
  ],
};

export const secret: EngineTable = {
  id: SECRET_ID,
  storage: "native",
  physicalName: "t_secret",
  primaryColumn: "code",
  columns: [
    { id: "s1", name: "code", label: "Code", fieldType: "text", config: {} },
  ],
};

export const orders: EngineTable = {
  id: ORDERS_ID,
  storage: "native",
  physicalName: "t_orders",
  primaryColumn: "title",
  columns: [
    { id: "o1", name: "title", label: "Title", fieldType: "text", config: {} },
    {
      id: "o2",
      name: "price",
      label: "Price",
      fieldType: "number",
      config: {},
    },
    { id: "o3", name: "qty", label: "Qty", fieldType: "number", config: {} },
    {
      id: "o4",
      name: "total",
      label: "Total",
      fieldType: "formula",
      config: {
        expr: {
          op: "mul",
          left: { op: "col", name: "price" },
          right: { op: "col", name: "qty" },
        },
      },
    },
    {
      id: "o5",
      name: "status",
      label: "Status",
      fieldType: "single_select",
      config: {
        options: [
          { name: "Open", color: "green" },
          { name: "Closed", color: "gray" },
        ],
      },
    },
    {
      id: "o6",
      name: "tags",
      label: "Tags",
      fieldType: "multi_select",
      config: { options: [{ name: "vip", color: "red" }] },
    },
    { id: "o7", name: "due", label: "Due", fieldType: "date", config: {} },
    {
      id: "o8",
      name: "client",
      label: "Client",
      fieldType: "relation_one_to_many",
      config: {},
      relation: {
        kind: "one_to_many",
        direction: "forward",
        targetTableId: CLIENTS_ID,
        fkColumn: "client",
      },
    },
    {
      id: "o9",
      name: "client_city",
      label: "Client city",
      fieldType: "lookup",
      config: { relation: "client", target: "city" },
    },
    {
      id: "o10",
      name: "codes",
      label: "Codes",
      fieldType: "relation_many_to_many",
      config: {},
      relation: {
        kind: "many_to_many",
        direction: "forward",
        targetTableId: SECRET_ID,
        junction: "j_codes",
      },
    },
    {
      id: "o11",
      name: "code_count",
      label: "Code count",
      fieldType: "rollup",
      config: { relation: "codes", target: "code", fn: "count" },
    },
    {
      id: "o12",
      name: "broken",
      label: "Broken",
      fieldType: "formula",
      config: { expr: { op: "col", name: "gone" } },
    },
    {
      id: "o13",
      name: "created",
      label: "Created",
      fieldType: "created_time",
      config: {},
    },
  ],
};

export function catalogFor(readableSecret = false): EngineCatalog {
  return {
    table: orders,
    tables: new Map([
      [CLIENTS_ID, clients],
      [SECRET_ID, secret],
    ]),
    readable: (id) => id !== SECRET_ID || readableSecret,
  };
}
