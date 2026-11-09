import { describe, expect, it } from "vitest";
import { buildOpenApi } from "./rest-api.js";

const columns = [
  {
    name: "title",
    label: "Title",
    fieldType: "text",
    kind: "text",
    config: {},
    description: null,
  },
  {
    name: "status",
    label: "Status",
    fieldType: "single_select",
    kind: "text",
    config: { options: [{ name: "Open" }, { name: "Done" }] },
    description: null,
  },
  {
    name: "total",
    label: "Total",
    fieldType: "formula",
    kind: "number",
    config: {},
    description: "Price × qty",
  },
  {
    name: "client",
    label: "Client",
    fieldType: "relation_one_to_many",
    kind: "links",
    config: {},
    description: null,
  },
] as never;

describe("buildOpenApi", () => {
  it("describes each table's records with typed, read-only, and link fields", () => {
    const document = buildOpenApi(
      { id: "base-1", name: "CRM" },
      [{ id: "11111111-2222-4333-8444-555555555555", name: "Deals", columns }],
      "https://grid.example.org",
    );
    expect(document.openapi).toBe("3.1.0");
    expect(document.servers[0]?.url).toBe("https://grid.example.org/api/v1");
    const schema = document.components.schemas[
      "Table_11111111222243338444555555555555"
    ] as {
      properties: Record<string, Record<string, unknown>>;
    };
    expect(schema.properties.status).toMatchObject({
      type: "string",
      enum: ["Open", "Done"],
    });
    // A computed number is exact: decimal text, never a JSON float.
    expect(schema.properties.total).toMatchObject({
      type: "string",
      format: "decimal",
      readOnly: true,
      description: "Price × qty",
    });
    expect(schema.properties.client?.readOnly).toBeUndefined();
    expect(Object.keys(document.paths)).toEqual([
      "/tables/11111111-2222-4333-8444-555555555555/records",
      "/tables/11111111-2222-4333-8444-555555555555/records/{recordId}",
    ]);
  });

  it("has no paths for a base without readable tables", () => {
    expect(
      buildOpenApi({ id: "b", name: "Empty" }, [], "http://localhost:4000")
        .paths,
    ).toEqual({});
  });
});
