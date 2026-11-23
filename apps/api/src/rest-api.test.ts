import { describe, expect, it } from "vitest";
import { listQuerySchema } from "./public-api/types.js";
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
      "/bases",
      "/bases/base-1/tables",
      "/bases/base-1/openapi.json",
      "/tables/11111111-2222-4333-8444-555555555555/records",
      "/tables/11111111-2222-4333-8444-555555555555/records/{recordId}",
    ]);
  });

  it("describes the routes of the base alone when it has no readable table", () => {
    expect(
      Object.keys(
        buildOpenApi({ id: "b", name: "Empty" }, [], "http://localhost:4000")
          .paths,
      ),
    ).toEqual(["/bases", "/bases/b/tables", "/bases/b/openapi.json"]);
  });

  it("writes a list's parameters from the schema the list is read with", () => {
    type Parameter = {
      name: string;
      in: string;
      description?: string;
      schema: Record<string, unknown>;
    };
    const document = buildOpenApi(
      { id: "base-1", name: "CRM" },
      [{ id: "11111111-2222-4333-8444-555555555555", name: "Deals", columns }],
      "https://grid.example.org",
    );
    const records = document.paths[
      "/tables/11111111-2222-4333-8444-555555555555/records"
    ] as Record<string, { parameters: Parameter[]; requestBody?: unknown }>;
    const listed = records.get?.parameters ?? [];
    // Every name the server reads, and no other: `timeZone` was read
    // and not said.
    expect(listed.map((parameter) => parameter.name).sort()).toEqual(
      Object.keys(listQuerySchema.shape).sort(),
    );
    expect(listed.every((parameter) => parameter.in === "query")).toBe(true);
    const named = (name: string) =>
      listed.find((parameter) => parameter.name === name)?.schema;
    expect(named("limit")).toEqual({
      type: "integer",
      minimum: 1,
      maximum: 1000,
      default: 100,
    });
    expect(named("offset")).toMatchObject({ type: "integer", minimum: 0 });
    expect(named("search")).toMatchObject({ minLength: 1, maxLength: 200 });
    expect(named("sort")).toMatchObject({ minLength: 1 });
    expect(named("fieldKey")).toMatchObject({ enum: ["name", "label"] });
    // A write says the reason a field may ask for, and holds a record.
    for (const method of ["post", "patch", "delete"]) {
      expect(
        records[method]?.parameters.find(
          (parameter) => parameter.in === "header",
        )?.name,
      ).toBe("X-Reason");
    }
    expect(JSON.stringify(records.post?.requestBody)).toContain('"minItems":1');
    // One record takes the key its fields are named by, as the list does.
    const one = document.paths[
      "/tables/11111111-2222-4333-8444-555555555555/records/{recordId}"
    ] as Record<string, { parameters: Parameter[] }>;
    expect(one.get?.parameters.map((parameter) => parameter.name)).toEqual([
      "recordId",
      "fieldKey",
    ]);
  });
});
