import { describe, expect, it } from "vitest";
import { recordIds, writeBodySchema } from "./operations.js";
import { listQuerySchema } from "./types.js";

describe("recordIds", () => {
  it("parses a comma list and rejects an empty one", () => {
    const a = "11111111-1111-4111-8111-111111111111";
    const b = "22222222-2222-4222-8222-222222222222";
    expect(recordIds(`${a},${b}`)).toEqual([a, b]);
    expect(recordIds("")).toBeNull();
  });
});

describe("listQuerySchema", () => {
  it("defaults limit and rejects above 1000", () => {
    expect(listQuerySchema.parse({}).limit).toBe(100);
    expect(listQuerySchema.safeParse({ limit: 1001 }).success).toBe(false);
  });

  it("reads a whole number written in digits, and no other writing of one", () => {
    expect(listQuerySchema.parse({ limit: "10", offset: "0" })).toMatchObject({
      limit: 10,
      offset: 0,
    });
    // A tool sends numbers, not their text.
    expect(listQuerySchema.parse({ limit: 10 }).limit).toBe(10);
    // `Number` reads these too: the document calls none an integer.
    for (const limit of ["0x10", "1e3", " 1", "1.0", "+1", "", "ten", 1.5]) {
      expect(listQuerySchema.safeParse({ limit }).success).toBe(false);
      expect(listQuerySchema.safeParse({ offset: limit }).success).toBe(false);
    }
  });

  it("refuses an empty sort, filter, list of fields, or search", () => {
    for (const name of ["sort", "filter", "fields", "search"]) {
      expect(listQuerySchema.safeParse({ [name]: "" }).success).toBe(false);
      expect(listQuerySchema.safeParse({ [name]: "x" }).success).toBe(true);
    }
  });
});

describe("writeBodySchema", () => {
  it("accepts one record and rejects more than 100", () => {
    expect(
      writeBodySchema.safeParse({
        records: [{ fields: { title: "x" } }],
      }).success,
    ).toBe(true);
    expect(
      writeBodySchema.safeParse({
        records: Array.from({ length: 101 }, () => ({ fields: {} })),
      }).success,
    ).toBe(false);
  });
});
