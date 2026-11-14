import { beforeEach, describe, expect, it, vi } from "vitest";

function memoryStorage() {
  const kept = new Map<string, string>();
  return {
    getItem: (key: string) => kept.get(key) ?? null,
    setItem: (key: string, value: string) => void kept.set(key, value),
  };
}

const blocked = {
  getItem: (): string | null => {
    throw new Error("blocked");
  },
  setItem: (): void => {
    throw new Error("blocked");
  },
};

// Each test starts from a page that has hidden nothing yet.
async function load() {
  return import("./grid-tips");
}

describe("grid tips", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("show until hidden, then stay hidden in this browser", async () => {
    const storage = memoryStorage();
    const { gridTipsHidden, hideGridTips } = await load();
    expect(gridTipsHidden(storage)).toBe(false);
    hideGridTips(storage);
    expect(gridTipsHidden(storage)).toBe(true);
    // Another page of the same browser reads what was kept.
    vi.resetModules();
    expect((await load()).gridTipsHidden(storage)).toBe(true);
  });

  it("show where storage is blocked, and hide for the page alone", async () => {
    const { gridTipsHidden, hideGridTips } = await load();
    expect(gridTipsHidden(blocked)).toBe(false);
    expect(() => hideGridTips(blocked)).not.toThrow();
    expect(gridTipsHidden(blocked)).toBe(true);
    vi.resetModules();
    expect((await load()).gridTipsHidden(blocked)).toBe(false);
  });

  it("show again for a value they do not know", async () => {
    const storage = memoryStorage();
    storage.setItem("ag_grid_tips", "something else");
    expect((await load()).gridTipsHidden(storage)).toBe(false);
  });
});
