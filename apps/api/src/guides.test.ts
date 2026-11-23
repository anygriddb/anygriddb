/**
 * The guides say what the code does: a figure or a name copied into them by
 * hand is read here against the constant it was copied from, so that one
 * cannot change without the other.
 */
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { IMPORT_LIMITS } from "./import-file.js";
import { registry } from "./observability.js";
import { RATE_LIMITS } from "./rate-limit.js";

const guide = (path: string) =>
  readFile(new URL(`../../../${path}`, import.meta.url), "utf8");

/** A count as the guides write it: `3,000`. */
const written = (count: number) => count.toLocaleString("en-US");

describe("the guides", () => {
  it("name every series the server registers", async () => {
    const operations = await guide("docs/operations.md");
    const series = (await registry.getMetricsAsJSON())
      .map((metric) => metric.name)
      // The process's own are named as two families.
      .filter((name) => /^anygriddb_(?!process_|nodejs_)/.test(name));
    expect(series.length).toBeGreaterThan(10);
    expect(
      series.filter((name) => !operations.includes(`\`${name}\``)),
    ).toEqual([]);
  });

  it("give the request limits the server applies", async () => {
    const architecture = await guide("ARCHITECTURE.md");
    const line =
      architecture
        .split("\n")
        .find((text) => text.startsWith("- **Rate limits**")) ?? "";
    for (const [bucket, limit] of Object.entries(RATE_LIMITS)) {
      expect(line, bucket).toContain(` ${written(limit)}`);
    }
  });

  it("give the sizes an import takes, in the unit the server counts in", async () => {
    const operations = await guide("docs/operations.md");
    const mebibytes = (bytes: number) => String(bytes / (1024 * 1024));
    expect(operations).toContain(
      `${mebibytes(IMPORT_LIMITS.maxTextBytes)} MiB for CSV and TSV, ${mebibytes(IMPORT_LIMITS.maxXlsxBytes)} MiB for Excel, ${mebibytes(IMPORT_LIMITS.maxJsonBytes)} MiB for JSON`,
    );
  });
});
