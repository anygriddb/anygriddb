import { describe, expect, it } from "vitest";
import { sourceDatabaseField, sourceInputSchema } from "./sources";

describe("sourceDatabaseField", () => {
  it("calls Oracle's field a service name", () => {
    expect(sourceDatabaseField("oracle")).toBe("service");
  });

  it("calls every other engine's field a database", () => {
    expect(sourceDatabaseField("postgres")).toBe("database");
    expect(sourceDatabaseField("mongodb")).toBe("database");
    expect(sourceDatabaseField("sqlserver")).not.toBe("service");
  });

  it("calls a search cluster's field indices", () => {
    expect(sourceDatabaseField("opensearch")).toBe("indices");
  });

  it("accepts a SQLite source without an account or a password", () => {
    const parsed = sourceInputSchema.parse({
      name: "local",
      engine: "sqlite",
      host: "localhost",
      port: 1,
      database: "/var/lib/anygriddb/demo.sqlite",
      username: "",
      password: "",
    });
    expect(parsed.engine).toBe("sqlite");
  });
});
