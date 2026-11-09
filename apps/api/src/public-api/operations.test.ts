import { describe, expect, it } from "vitest";
import { listQuerySchema, recordIds, writeBodySchema } from "./operations.js";

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
