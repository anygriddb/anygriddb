import { describe, expect, it } from "vitest";
import { HostAllowList } from "./allow-list.js";

describe("source host allow list", () => {
  it("allows listed names, domains, addresses, and ranges only", () => {
    const list = new HostAllowList(
      " db.internal, *.corp.example ,10.0.0.0/8,192.168.1.20, fd00::/8",
    );
    expect(list.allows("db.internal")).toBe(true);
    expect(list.allows("DB.Internal")).toBe(true);
    expect(list.allows("erp.corp.example")).toBe(true);
    expect(list.allows("corp.example")).toBe(false);
    expect(list.allows("evilcorp.example")).toBe(false);
    expect(list.allows("10.20.30.40")).toBe(true);
    expect(list.allows("11.0.0.1")).toBe(false);
    expect(list.allows("192.168.1.20")).toBe(true);
    expect(list.allows("fd12::1")).toBe(true);
    expect(list.allows("db.internal.attacker.example")).toBe(false);
  });

  it("allows nothing when empty, and refuses a malformed entry", () => {
    expect(new HostAllowList("").allows("localhost")).toBe(false);
    expect(new HostAllowList(undefined).entries).toEqual([]);
    expect(() => new HostAllowList("*")).toThrow(/invalid entry/);
    expect(() => new HostAllowList("10.0.0.0/40")).toThrow(/invalid range/);
  });
});
