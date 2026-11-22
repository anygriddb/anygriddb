import { describe, expect, it } from "vitest";
import {
  linkColumnConfig,
  parseColumnConfig,
  readerColumnConfig,
  rollupFitsTarget,
} from "./field-config";

describe("parseColumnConfig", () => {
  it("upgrades string options and validates per type", () => {
    expect(parseColumnConfig("single_select", { options: ["A", "B"] })).toEqual(
      {
        options: [
          { name: "A", color: "gray" },
          { name: "B", color: "red" },
        ],
      },
    );
    expect(
      parseColumnConfig("rollup", {
        relation: "client",
        target: "amount",
        fn: "sum",
      }),
    ).toEqual({
      relation: "client",
      target: "amount",
      fn: "sum",
    });
    expect(
      parseColumnConfig("lookup", {
        relation: "client",
        target: "name",
        fn: undefined,
      }),
    ).toEqual({
      relation: "client",
      target: "name",
    });
    expect(parseColumnConfig("text", null)).toEqual({});
  });

  it("rejects unknown keys and bad values", () => {
    expect(() => parseColumnConfig("text", { options: ["A"] })).toThrow(
      "Invalid column",
    );
    expect(() =>
      parseColumnConfig("single_select", { options: ["A", "A"] }),
    ).toThrow("Invalid column");
    expect(() =>
      parseColumnConfig("number", { number: { precision: 12 } }),
    ).toThrow("Invalid column");
    // A number that refuses negatives takes no negative default.
    expect(
      parseColumnConfig("number", { nonNegative: true, defaultValue: 0 }),
    ).toMatchObject({ nonNegative: true });
    expect(() =>
      parseColumnConfig("number", { nonNegative: true, defaultValue: -1 }),
    ).toThrow("Invalid column");
    expect(() => parseColumnConfig("text", { nonNegative: true })).toThrow(
      "Invalid column",
    );
    expect(() =>
      parseColumnConfig("datetime", { date: { timeZone: "Mars/Base" } }),
    ).toThrow("Invalid column");
  });

  it("accepts appearance for selects and boolean, and rejects a bad one", () => {
    expect(
      parseColumnConfig("single_select", {
        options: ["Open"],
        appearance: "radio",
      }),
    ).toMatchObject({ appearance: "radio" });
    expect(
      parseColumnConfig("multi_select", {
        options: ["A"],
        appearance: "checklist",
      }),
    ).toMatchObject({ appearance: "checklist" });
    expect(
      parseColumnConfig("boolean", { appearance: "switch" }),
    ).toMatchObject({ appearance: "switch" });
    expect(
      parseColumnConfig("rating", {
        ratingMax: 5,
        ratingIcon: "heart",
        ratingColor: "pink",
      }),
    ).toEqual({
      ratingMax: 5,
      ratingIcon: "heart",
      ratingColor: "pink",
    });
    expect(() =>
      parseColumnConfig("single_select", {
        options: ["A"],
        appearance: "checklist",
      }),
    ).toThrow("Invalid column");
    expect(() => parseColumnConfig("boolean", { appearance: "badge" })).toThrow(
      "Invalid column",
    );
  });

  it("draws a short text as a code, where a field holds one", () => {
    // The field's own value, a link, a number the table gives, the row's
    // id, or what a formula makes of another field.
    for (const fieldType of ["text", "url", "autonumber", "row_id"] as const) {
      expect(parseColumnConfig(fieldType, { appearance: "qr" })).toEqual({
        appearance: "qr",
      });
    }
    expect(
      parseColumnConfig("formula", {
        expr: { op: "col", name: "reference" },
        appearance: "barcode",
      }),
    ).toMatchObject({ appearance: "barcode" });
    expect(parseColumnConfig("text", {})).toEqual({});
    // A code is one of the two, and a field that holds no short text
    // takes none.
    expect(() =>
      parseColumnConfig("text", { appearance: "datamatrix" }),
    ).toThrow("Invalid column");
    expect(() => parseColumnConfig("long_text", { appearance: "qr" })).toThrow(
      "Invalid column",
    );
    expect(() =>
      parseColumnConfig("number", { appearance: "barcode" }),
    ).toThrow("Invalid column");
  });
});

describe("rollupFitsTarget", () => {
  it("computes numbers on numbers, durations, and checkboxes", () => {
    for (const fn of ["sum", "avg", "std_dev_pop", "variance_pop"] as const) {
      expect(rollupFitsTarget(fn, "number")).toBe(true);
      expect(rollupFitsTarget(fn, "duration")).toBe(true);
      // A checked box counts 1.
      expect(rollupFitsTarget(fn, "boolean")).toBe(true);
      expect(rollupFitsTarget(fn, "text")).toBe(false);
      expect(rollupFitsTarget(fn, "date")).toBe(false);
    }
  });

  it("keeps dates for dates, and lets computed fields choose", () => {
    expect(rollupFitsTarget("earliest", "datetime")).toBe(true);
    expect(rollupFitsTarget("latest", "number")).toBe(false);
    expect(rollupFitsTarget("sum", "formula")).toBe(true);
    expect(rollupFitsTarget("sum", "rollup")).toBe(true);
    expect(rollupFitsTarget("concatenate", "text")).toBe(true);
    expect(rollupFitsTarget("count", "attachment")).toBe(true);
  });
});

describe("a field's settings on a public link", () => {
  it("keeps how values are drawn, and nothing else", () => {
    const kept = linkColumnConfig({
      options: [{ name: "A", color: "red" }],
      preventNewOptions: true,
      appearance: "badge",
      number: { precision: 2, style: "currency", currency: "EUR" },
      nonNegative: true,
      date: { format: "eu" },
      durationFormat: "h:mm",
      ratingMax: 5,
      ratingIcon: "star",
      ratingColor: "red",
      multiple: true,
      richText: true,
      expr: { op: "col", name: "salary" },
      relation: "link",
      target: "salary",
      fn: "sum",
      defaultValue: "91234",
      notify: true,
      inverseOf: "00000000-0000-4000-8000-000000000000",
      selectFrom: {
        filter: {
          conjunction: "and",
          conditions: [{ column: "salary", op: "gt", value: 91234 }],
        },
      },
      filter: {
        conjunction: "and",
        conditions: [{ column: "salary", op: "gt", value: 91234 }],
      },
      button: { label: "Go", action: "open_url", url: "https://example.org" },
    });
    expect(Object.keys(kept).sort()).toEqual(
      [
        "appearance",
        "date",
        "durationFormat",
        "multiple",
        "nonNegative",
        "number",
        "options",
        "preventNewOptions",
        "ratingColor",
        "ratingIcon",
        "ratingMax",
        "richText",
      ].sort(),
    );
    expect(JSON.stringify(kept)).not.toContain("91234");
    expect(JSON.stringify(kept)).not.toContain("salary");
  });
});

describe("a field's settings under a reader's field rules", () => {
  const rules = {
    hidden: (name: string) => name === "salary",
    linkedHidden: (name: string) => name === "secret",
  };
  const onSecret = {
    conjunction: "and" as const,
    conditions: [{ column: "secret", op: "is" as const, value: "S3" }],
  };

  it("takes out a formula that reads a hidden field", () => {
    const kept = readerColumnConfig(
      {
        expr: {
          op: "gt",
          left: { op: "col", name: "salary" },
          right: { op: "num", value: 91234 },
        },
        number: { precision: 2 },
      } as never,
      rules,
    );
    expect(kept.expr).toBeUndefined();
    expect(kept.number).toEqual({ precision: 2 });
  });

  it("keeps a formula on fields the reader sees", () => {
    const config = { expr: { op: "col", name: "title" } } as never;
    expect(readerColumnConfig(config, rules)).toEqual(config);
  });

  it("takes out a lookup through or onto a hidden field", () => {
    for (const config of [
      { relation: "salary", target: "name" },
      { relation: "link", target: "secret", fn: "sum" as const },
    ]) {
      const kept = readerColumnConfig(config, rules);
      expect(kept.relation).toBeUndefined();
      expect(kept.target).toBeUndefined();
      expect(kept.fn).toBeUndefined();
    }
  });

  it("keeps a lookup but not its condition on a hidden field", () => {
    const kept = readerColumnConfig(
      { relation: "link", target: "name", filter: onSecret },
      rules,
    );
    expect(kept).toEqual({ relation: "link", target: "name" });
  });

  it("keeps a link's selection without its conditions on a hidden field", () => {
    const kept = readerColumnConfig(
      {
        selectFrom: {
          filter: {
            conjunction: "and",
            conditions: [
              { column: "secret", op: "is", value: "S3" },
              { column: "name", op: "is", value: "A" },
            ],
          },
        },
      },
      rules,
    );
    expect(JSON.stringify(kept)).not.toContain("secret");
    expect(JSON.stringify(kept)).toContain('"name"');
  });

  it("empties a button's address where it names a hidden field", () => {
    const kept = readerColumnConfig(
      {
        button: {
          label: "Open",
          action: "open_url",
          url: "https://example.org/{{ salary }}/{{title}}",
        },
      },
      rules,
    );
    expect(kept.button?.url).toBe("https://example.org//{{title}}");
  });
});
