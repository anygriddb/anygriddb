import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { appScriptPath, coverageTotals, pagePath } from "./journey-coverage";

describe("appScriptPath", () => {
  it("takes a script of the app's build", () => {
    expect(appScriptPath("https://localhost:4010/assets/grid-a1b2.js")).toBe(
      "/assets/grid-a1b2.js",
    );
  });

  it.each([
    "https://localhost:4010/assets/nested/grid.js",
    "https://localhost:4010/assets/grid.css",
    "https://localhost:4010/grid.js",
    "chrome-extension://id/assets/grid.js/more",
    "evaluate-script",
    "",
  ])("leaves out %j", (url) => {
    expect(appScriptPath(url)).toBeNull();
  });
});

describe("pagePath", () => {
  it("takes the ids out of a page's path", () => {
    expect(
      pagePath(
        "https://localhost:4010/bases/0190f2c1-7b1a-7c3e-9d10-3f2a1b4c5d6e/tables?view=1",
      ),
    ).toBe("/bases/<id>/tables");
  });

  it("keeps what is not an address as it is", () => {
    expect(pagePath("not an address")).toBe("not an address");
  });
});

describe("coverageTotals", () => {
  it("counts what ran and what did not", () => {
    expect(
      coverageTotals([
        { s: { 0: 1, 1: 0 }, f: { 0: 3 } },
        { s: { 0: 0 }, f: { 0: 0, 1: 2 } },
      ]),
    ).toEqual({
      files: 2,
      statements: 3,
      statementsRun: 1,
      functions: 3,
      functionsRun: 2,
    });
  });

  it("counts nothing when no file was measured", () => {
    expect(coverageTotals([]).files).toBe(0);
  });
});

describe("the journeys", () => {
  const folder = fileURLToPath(new URL("../e2e/", import.meta.url));

  it("all take their test from the module that can measure them", () => {
    const journeys = readdirSync(folder).filter((name) =>
      /\.(spec|setup)\.ts$/.test(name),
    );
    expect(journeys.length).toBeGreaterThan(0);
    const unmeasured = journeys.filter((name) =>
      /import \{[^}]*\btest\b[^}]*\} from "@playwright\/test"/.test(
        readFileSync(`${folder}${name}`, "utf8"),
      ),
    );
    expect(unmeasured).toEqual([]);
  });
});
