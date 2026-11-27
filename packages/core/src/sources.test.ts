import { describe, expect, it } from "vitest";
import { sourceInputSchema } from "./sources.js";

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
