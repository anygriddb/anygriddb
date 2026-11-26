import type { Database } from "@anygriddb/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

const settings = vi.hoisted(() => {
  const limits: Record<string, number> = {};
  return { limits };
});

vi.mock("./settings.js", () => ({
  readGateSettings: async () => settings,
}));

const { exportCeiling, importCeiling } = await import("./row-ceilings.js");

const db = {} as Database;

describe("the rows of a file", () => {
  beforeEach(() => {
    settings.limits = {};
  });

  it("are the catalogue's until Administration sets them", async () => {
    expect(await importCeiling(db)).toBe(1_000_000);
    expect(await exportCeiling(db)).toBe(1_000_000);
    settings.limits = {
      "import.max_rows": 2_500_000,
      "export.max_rows": 300_000,
    };
    expect(await importCeiling(db)).toBe(2_500_000);
    expect(await exportCeiling(db)).toBe(300_000);
  });

  it("are the environment's when it fixes them, whatever Administration set", async () => {
    settings.limits = { "import.max_rows": 2_500_000 };
    expect(await importCeiling(db, { IMPORT_MAX_ROWS: 400_000 })).toBe(400_000);
    // A variable for the other leaves this one to Administration.
    expect(await importCeiling(db, { EXPORT_MAX_ROWS: 400_000 })).toBe(
      2_500_000,
    );
  });
});
