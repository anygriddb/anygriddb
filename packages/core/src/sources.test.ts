import { describe, expect, it } from "vitest";
import { sourceInputSchema, sourceUpdateSchema } from "./sources.js";

describe("sourceInputSchema", () => {
  const base = {
    name: "ERP",
    engine: "postgres" as const,
    host: "db.example",
    port: 5432,
    database: "app",
    username: "reader",
    password: "secret-password",
  };

  it("defaults allowPlaintext to false and accepts an opt-in", () => {
    expect(sourceInputSchema.parse(base).allowPlaintext).toBe(false);
    expect(
      sourceInputSchema.parse({ ...base, allowPlaintext: true }).allowPlaintext,
    ).toBe(true);
  });

  it("refuses a certificate that is not PEM", () => {
    expect(() =>
      sourceInputSchema.parse({ ...base, tlsCa: "not a certificate" }),
    ).toThrow();
  });
});

describe("sourceUpdateSchema", () => {
  const id = "0b5c4f3e-8a5e-4c43-9f61-2d4b8d1c7a10";

  it("changes only what it names, with no default filled in", () => {
    const parsed = sourceUpdateSchema.parse({ id, name: "Renamed" });
    expect(parsed).toEqual({ id, name: "Renamed" });
  });

  it("takes plaintext asked, and refuses what a source does not hold", () => {
    expect(
      sourceUpdateSchema.parse({ id, allowPlaintext: true }).allowPlaintext,
    ).toBe(true);
    expect(sourceUpdateSchema.safeParse({ id, colour: "red" }).success).toBe(
      false,
    );
  });
});
