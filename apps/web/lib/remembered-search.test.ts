import { describe, expect, it } from "vitest";
import {
  rememberSearch,
  visitSearch,
  type SearchMemory,
} from "./remembered-search";

function memory(): SearchMemory & { dump(): Record<string, string> } {
  const kept = new Map<string, string>();
  return {
    getItem: (key) => kept.get(key) ?? null,
    setItem: (key, value) => {
      kept.set(key, value);
    },
    removeItem: (key) => {
      kept.delete(key);
    },
    dump: () => Object.fromEntries(kept),
  };
}

const parse = (value: unknown) => {
  const row = value as { level?: string };
  return row.level === "warn" || row.level === "error" || row.level === "info"
    ? { level: row.level }
    : {};
};

describe("a page's remembered address", () => {
  it("keeps a choice and drops a value it does not know", () => {
    const store = memory();
    const remembered = rememberSearch("ag.admin.logs", parse, store);
    remembered.write({ level: "error" });
    expect(remembered.read()).toEqual({ level: "error" });
    store.setItem("ag.admin.logs", '{"level":"sideways"}');
    expect(remembered.read()).toEqual({});
    remembered.write({});
    expect(store.dump()).toEqual({});
  });

  it("lets the address win, and restores a bare one", () => {
    const store = memory();
    const remembered = rememberSearch("ag.admin.logs", parse, store);
    remembered.write({ level: "warn" });
    expect(
      visitSearch(
        { level: "error" },
        () => remembered.read(),
        (value) => remembered.write(value),
      ),
    ).toEqual({ search: { level: "error" }, replaceUrl: null });
    expect(remembered.read()).toEqual({ level: "error" });
    remembered.write({ level: "warn" });
    expect(
      visitSearch(
        {},
        () => remembered.read(),
        () => undefined,
      ),
    ).toEqual({
      search: { level: "warn" },
      replaceUrl: { level: "warn" },
    });
    remembered.write({});
    expect(
      visitSearch(
        {},
        () => remembered.read(),
        () => undefined,
      ),
    ).toEqual({
      search: {},
      replaceUrl: null,
    });
  });

  it("ignores a store that throws", () => {
    const broken: SearchMemory = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    const remembered = rememberSearch("ag.admin.logs", parse, broken);
    expect(remembered.read()).toEqual({});
    expect(() => remembered.write({ level: "warn" })).not.toThrow();
  });
});
