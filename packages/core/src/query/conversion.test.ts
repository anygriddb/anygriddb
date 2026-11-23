import { describe, expect, it } from "vitest";
import type { FieldType } from "../field-types";
import {
  buildConversionGuard,
  buildConversionOptions,
  buildConversionRead,
  buildConversionStamp,
  buildConversionWrite,
  buildDropConversionColumns,
  conversionZone,
  isConvertible,
  isMetadataConversion,
  isStoredAlike,
  storedFromJson,
} from "./conversion";

describe("what a conversion touches", () => {
  it("changes only the catalog where every value already fits", () => {
    expect(isMetadataConversion("email", "text")).toBe(true);
    expect(isMetadataConversion("text", "long_text")).toBe(true);
    expect(isMetadataConversion("rating", "number")).toBe(true);
    for (const [from, to] of [
      ["text", "single_select"],
      ["text", "url"],
      ["text", "email"],
      ["long_text", "text"],
      ["number", "rating"],
      ["number", "duration"],
      ["multi_select", "attachment"],
    ] as Array<[FieldType, FieldType]>) {
      expect([from, to, isMetadataConversion(from, to)]).toEqual([
        from,
        to,
        false,
      ]);
    }
    expect(isConvertible("attachment", "text")).toBe(false);
    expect(isStoredAlike("text", "url")).toBe(true);
    expect(isStoredAlike("text", "number")).toBe(false);
  });

  it("asks a zone between a day and an instant", () => {
    expect(conversionZone("date", "datetime")).toBe("required");
    expect(conversionZone("datetime", "date")).toBe("required");
    expect(conversionZone("text", "datetime")).toBe("used");
    expect(conversionZone("text", "number")).toBe("none");
  });
});

describe("a conversion's statements", () => {
  it("reads a batch in id order, an instant's day in the zone given", () => {
    const read = buildConversionRead({
      table: "t_x",
      column: "x",
      from: "datetime",
      to: "date",
      timeZone: "Europe/Paris",
      after: null,
      limit: 100,
    });
    expect(read.text).toContain(`"x" at time zone $3::text`);
    expect(read.text).toContain(`order by "id" limit $2::int`);
    expect(read.values).toEqual([null, 100, "Europe/Paris"]);
    expect(() =>
      buildConversionRead({
        table: "t_x",
        column: "x",
        from: "datetime",
        to: "date",
        after: null,
        limit: 100,
      }),
    ).toThrow("This conversion needs a time zone");
  });

  it("writes values bound, beside the field or in it", () => {
    const write = buildConversionWrite({
      table: "t_x",
      column: "x",
      to: "number",
      beside: true,
      marks: true,
      rows: [{ id: "i", value: "it's", changed: true }],
    });
    expect(write.text).toContain(`set "ag_tmp_x" = `);
    expect(write.text).toContain(`"ag_tmp_ag_changed" = v."changed"`);
    expect(write.text).not.toContain("it's");
    expect(
      buildConversionWrite({
        table: "t_x",
        column: "x",
        to: "url",
        beside: false,
        rows: [],
      }).text,
    ).toContain(`set "x" = `);
  });

  it("reads each stored type from JSON without raising on a bad document", () => {
    expect(storedFromJson("number", "j")).toContain("pg_input_is_valid");
    expect(storedFromJson("json", "j")).toContain("pg_input_is_valid");
    expect(storedFromJson("multi_select", "j")).toContain(
      "jsonb_array_elements_text",
    );
    expect(storedFromJson("relation_one_to_many", "j")).toContain("::uuid");
  });

  it("stamps only the rows marked, and takes its marks away", () => {
    expect(
      buildConversionStamp({ table: "t_x", after: null, limit: 10 }).text,
    ).toContain(`where "ag_tmp_ag_changed"`);
    expect(buildDropConversionColumns({ table: "t_x", column: "x" })).toEqual([
      {
        text: "select ag_conversion_drop_columns($1::text, $2::text)",
        values: ["t_x", "x"],
      },
    ]);
  });

  it("refuses a job id that is not one", () => {
    expect(() => buildConversionGuard("t_x", "1'); drop table x; --")).toThrow(
      "Invalid job",
    );
  });

  it("takes a list's names from its items, and a select's whole", () => {
    expect(
      buildConversionOptions({
        table: "t_x",
        column: "x",
        from: "text",
        to: "multi_select",
        limit: 200,
      }).text,
    ).toContain("regexp_split_to_table");
    expect(
      buildConversionOptions({
        table: "t_x",
        column: "x",
        from: "single_select",
        to: "multi_select",
        limit: 200,
      }).text,
    ).not.toContain("regexp_split_to_table");
  });
});
