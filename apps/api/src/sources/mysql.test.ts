import { describe, expect, it } from "vitest";
import { serverFlavor } from "./mysql.js";

describe("serverFlavor", () => {
  it("tells MySQL from MariaDB, and whether it is recent enough", () => {
    expect(serverFlavor("8.4.3")).toEqual({ engine: "mysql", supported: true });
    expect(serverFlavor("8.0.14")).toEqual({
      engine: "mysql",
      supported: true,
    });
    expect(serverFlavor("8.0.13").supported).toBe(false);
    expect(serverFlavor("5.7.44").supported).toBe(false);
    expect(serverFlavor("11.4.4-MariaDB-ubu2404")).toEqual({
      engine: "mariadb",
      supported: true,
    });
    expect(serverFlavor("10.5.27-MariaDB").supported).toBe(false);
  });
});
