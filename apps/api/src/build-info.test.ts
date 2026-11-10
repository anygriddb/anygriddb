import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BUILD, describeBuild, parseBuild, sourceBuild } from "./build-info.js";

describe("build info", () => {
  it("takes a production build's facts", () => {
    const build = parseBuild({
      version: "0.1.0",
      commit: "0123456789abcdef0123456789abcdef01234567",
      builtAt: "2026-11-10T09:30:00.000Z",
    });
    expect(describeBuild(build)).toBe(
      "AnyGridDB 0.1.0 (commit 0123456789ab, built 2026-11-10T09:30:00.000Z)",
    );
  });

  it("says when the commit was not recorded", () => {
    const build = parseBuild({
      version: "1.2.3-rc.1",
      commit: null,
      builtAt: "2026-11-10T09:30:00.000Z",
    });
    expect(describeBuild(build)).toBe(
      "AnyGridDB 1.2.3-rc.1 (commit not recorded, built 2026-11-10T09:30:00.000Z)",
    );
  });

  it("reads the root package.json's version from sources", () => {
    const root = JSON.parse(
      readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    expect(BUILD).toEqual({
      version: root.version,
      commit: null,
      builtAt: null,
    });
    expect(describeBuild(BUILD)).toBe(
      `AnyGridDB ${root.version} (from sources)`,
    );
  });

  it("refuses a version that is not semantic", () => {
    expect(() => sourceBuild({ version: "v0.1" })).toThrow();
    expect(() => sourceBuild({ name: "anygriddb-root" })).toThrow();
    expect(() =>
      parseBuild({ version: "0.1.0", commit: null, builtAt: null, extra: 1 }),
    ).toThrow();
  });

  it("refuses a commit or a date that is not one", () => {
    expect(() =>
      parseBuild({ version: "0.1.0", commit: "main", builtAt: null }),
    ).toThrow();
    expect(() =>
      parseBuild({ version: "0.1.0", commit: null, builtAt: "yesterday" }),
    ).toThrow();
  });
});
