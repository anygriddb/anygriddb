/**
 * The script's process reads nothing of the product, so its limits are
 * written out there: read as text here, never run, and held to the
 * catalogue's.
 */
import { readFileSync } from "node:fs";
import { ceilingOf, type LimitId } from "@anygriddb/core";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./runner.ts", import.meta.url), "utf8");

/** A constant's value as the file writes it. */
function written(name: string): number | null {
  const found = new RegExp(`const ${name} = ([0-9_]+);`).exec(source);
  return found?.[1] ? Number(found[1].replaceAll("_", "")) : null;
}

describe("what a script's process keeps of its log", () => {
  const limits: Array<[string, LimitId]> = [
    ["MAX_LOG_LINES", "automation.script_log_lines"],
    ["MAX_LOG_LENGTH", "automation.script_log_chars"],
    ["MAX_ERROR_LENGTH", "automation.script_error_chars"],
  ];

  it("is the catalogue's, written out where the product is not read", () => {
    for (const [name, id] of limits)
      expect(written(name), name).toBe(ceilingOf(id));
  });

  it("finds nothing where nothing is written", () => {
    expect(written("MAX_NOTHING")).toBeNull();
  });
});
