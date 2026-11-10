import { describe, expect, it } from "vitest";
import { parseColumnConfig, rollupFitsTarget } from "./field-config";

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
