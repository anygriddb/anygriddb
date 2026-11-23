import { describe, expect, it } from "vitest";
import { isAdministrator, mysqlTls, serverFlavor } from "./mysql.js";

describe("isAdministrator", () => {
  it("tells a reader's grants from an administrator's", () => {
    expect(isAdministrator(["GRANT SELECT, INSERT ON *.* TO `app`@`%`"])).toBe(
      false,
    );
    expect(isAdministrator(["GRANT  SELECT\n ON *.*  TO `app`@`%`"])).toBe(
      false,
    );
    expect(isAdministrator(["GRANT ALL ON `shop`.* TO `app`@`%`"])).toBe(false);
    expect(isAdministrator(["GRANT ALL PRIVILEGES ON *.* TO `a`@`%`"])).toBe(
      true,
    );
    expect(isAdministrator(["GRANT SELECT, SUPER ON *.* TO `a`@`%`"])).toBe(
      true,
    );
    expect(
      isAdministrator(["GRANT SELECT ON *.* TO `a`@`%` WITH GRANT OPTION"]),
    ).toBe(true);
  });

  it.each([
    ["spaces", `GRANT a${" ".repeat(200_000)}x`],
    ["brackets", `GRANT SELECT ${"(".repeat(200_000)} ON *.* TO \`a\`@\`%\``],
  ])("reads a line of %s built to slow it in one pass", (_name, line) => {
    const started = performance.now();
    isAdministrator([line]);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe("serverFlavor", () => {
  it("tells MySQL from MariaDB, and whether it is recent enough", () => {
    expect(serverFlavor("8.4.3")).toEqual({ engine: "mysql", supported: true });
    expect(serverFlavor("8.0.16")).toEqual({
      engine: "mysql",
      supported: true,
    });
    // 8.0.14 and 8.0.15 have no view of the check constraints a list of
    // tables reads: they were taken, and no table of theirs could be listed.
    expect(serverFlavor("8.0.15").supported).toBe(false);
    expect(serverFlavor("8.0.14").supported).toBe(false);
    expect(serverFlavor("8.0.13").supported).toBe(false);
    expect(serverFlavor("5.7.44").supported).toBe(false);
    expect(serverFlavor("11.4.4-MariaDB-ubu2404")).toEqual({
      engine: "mariadb",
      supported: true,
    });
    expect(serverFlavor("10.5.27-MariaDB").supported).toBe(false);
  });
});

describe("mysqlTls", () => {
  it("verifies the chain and the name, with or without a pasted authority", () => {
    expect(mysqlTls("PEM")).toEqual({
      rejectUnauthorized: true,
      verifyIdentity: true,
      ca: "PEM",
    });
    expect(mysqlTls(null)).toEqual({
      rejectUnauthorized: true,
      verifyIdentity: true,
      ca: undefined,
    });
  });
});
