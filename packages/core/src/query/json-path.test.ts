import { describe, expect, it } from "vitest";
import { jsonPathText, jsonSteps, parseJsonPath } from "./json-path";
import {
  parseServerVersion,
  POSTGRES,
  serverAtLeast,
  type SqlDialect,
} from "./dialect";

describe("parseJsonPath", () => {
  it("reads names, quoted names, and places, with or without $", () => {
    expect(parseJsonPath("$.a.b[0]")).toEqual([
      { key: "a" },
      { key: "b" },
      { index: 0 },
    ]);
    expect(parseJsonPath(".client.ville")).toEqual([
      { key: "client" },
      { key: "ville" },
    ]);
    expect(parseJsonPath('$["a b"][\'c"d\']."é"')).toEqual([
      { key: "a b" },
      { key: 'c"d' },
      { key: "é" },
    ]);
    expect(parseJsonPath("$")).toEqual([]);
  });

  it("refuses what the four engines would not read alike", () => {
    for (const path of [
      "a.b",
      "$.a.",
      "$[-1]",
      "$.a[*]",
      "$..a",
      '$["a"',
      "$.a b",
      `$${".a".repeat(33)}`,
    ]) {
      expect(() => parseJsonPath(path), path).toThrow("Invalid arguments");
    }
  });

  it("writes names quoted as JSON strings", () => {
    const steps = parseJsonPath('$["say \\"hi\\""][2]');
    expect(jsonSteps(steps)).toBe('."say \\"hi\\""[2]');
    expect(jsonPathText(steps)).toBe('$."say \\"hi\\""[2]');
  });
});

describe("server versions", () => {
  it("reads each engine's version text", () => {
    expect(parseServerVersion("16.4 (Debian 16.4-1.pgdg120+1)")).toEqual([
      16, 4,
    ]);
    expect(parseServerVersion("11.4.4-MariaDB-ubu2404")).toEqual([11, 4, 4]);
    expect(parseServerVersion("16.0.4135.4")).toEqual([16, 0, 4135]);
    expect(parseServerVersion("")).toBeUndefined();
    expect(parseServerVersion(null)).toBeUndefined();
  });

  it("compares part by part, an unknown version passing", () => {
    const at = (version?: number[]): SqlDialect =>
      version ? { ...POSTGRES, version } : POSTGRES;
    expect(serverAtLeast(at([16, 4]), [16])).toBe(true);
    expect(serverAtLeast(at([15, 9]), [16])).toBe(false);
    expect(serverAtLeast(at([8, 0, 13]), [8, 0, 14])).toBe(false);
    expect(serverAtLeast(at([8, 4]), [8, 0, 14])).toBe(true);
    expect(serverAtLeast(at(), [99])).toBe(true);
  });
});
