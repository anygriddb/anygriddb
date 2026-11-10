import { describe, expect, it } from "vitest";
import { incrementalDueFull } from "./sync.js";

const ready = {
  syncMode: "incremental",
  changeColumn: "updated_at",
  columns: [{ name: "id" }],
  watermark: "2026-01-01T00:00:00.000Z",
  refreshCount: 1,
  fullEvery: 24,
};

describe("incrementalDueFull", () => {
  it("always rebuilds a full-mode sync", () => {
    expect(incrementalDueFull({ ...ready, syncMode: "full" })).toBe(true);
  });

  it("rebuilds when the change column or watermark is missing", () => {
    expect(incrementalDueFull({ ...ready, changeColumn: null })).toBe(true);
    expect(incrementalDueFull({ ...ready, columns: null })).toBe(true);
    expect(incrementalDueFull({ ...ready, watermark: null })).toBe(true);
  });

  it("keeps incremental passes until the fullEvery cadence", () => {
    expect(incrementalDueFull({ ...ready, refreshCount: 0 })).toBe(false);
    expect(incrementalDueFull({ ...ready, refreshCount: 23 })).toBe(false);
    expect(incrementalDueFull({ ...ready, refreshCount: 24 })).toBe(true);
    expect(incrementalDueFull({ ...ready, refreshCount: 48 })).toBe(true);
  });

  it("treats a zero fullEvery as every refresh", () => {
    expect(
      incrementalDueFull({ ...ready, fullEvery: 0, refreshCount: 2 }),
    ).toBe(true);
  });
});
