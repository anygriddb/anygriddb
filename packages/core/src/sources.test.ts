import { describe, expect, it } from "vitest";
import { sourceDatabaseField } from "./sources";

describe("sourceDatabaseField", () => {
  it("calls Oracle's field a service name", () => {
    expect(sourceDatabaseField("oracle")).toBe("service");
  });

  it("calls every other engine's field a database", () => {
    expect(sourceDatabaseField("postgres")).toBe("database");
    expect(sourceDatabaseField("mongodb")).toBe("database");
    expect(sourceDatabaseField("sqlserver")).not.toBe("service");
  });
});
