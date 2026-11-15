import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_ADMIN_PAGE_SIZE,
  parseAdminPageSize,
  readAdminPageSize,
  writeAdminPageSize,
} from "./admin-page-size";

const store = new Map<string, string>();

beforeEach(() => {
  store.clear();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
      clear: () => {
        store.clear();
      },
    },
  });
});

afterEach(() => {
  store.clear();
});

describe("parseAdminPageSize", () => {
  it("keeps 20, 50, and 100", () => {
    expect(parseAdminPageSize("20")).toBe(20);
    expect(parseAdminPageSize("50")).toBe(50);
    expect(parseAdminPageSize("100")).toBe(100);
  });

  it("falls back for anything else", () => {
    expect(parseAdminPageSize(null)).toBe(DEFAULT_ADMIN_PAGE_SIZE);
    expect(parseAdminPageSize("")).toBe(DEFAULT_ADMIN_PAGE_SIZE);
    expect(parseAdminPageSize("10")).toBe(DEFAULT_ADMIN_PAGE_SIZE);
    expect(parseAdminPageSize("200")).toBe(DEFAULT_ADMIN_PAGE_SIZE);
    expect(parseAdminPageSize("nope")).toBe(DEFAULT_ADMIN_PAGE_SIZE);
  });
});

describe("read and write", () => {
  it("round-trips a chosen size", () => {
    writeAdminPageSize(100);
    expect(readAdminPageSize()).toBe(100);
  });

  it("defaults when nothing is stored", () => {
    expect(readAdminPageSize()).toBe(DEFAULT_ADMIN_PAGE_SIZE);
  });
});
