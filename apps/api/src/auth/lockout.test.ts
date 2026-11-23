import { beforeEach, describe, expect, it } from "vitest";
import {
  countUnknownAddressFailure,
  forgetUnknownAddresses,
  unknownAddressLocked,
} from "./lockout.js";

const POLICY = { lockoutThreshold: 3, lockoutMinutes: 15 };
const AT = new Date("2026-01-10T08:00:00Z");
const later = (minutes: number) => new Date(AT.getTime() + minutes * 60_000);

describe("the lock of an address with no account", () => {
  beforeEach(() => {
    forgetUnknownAddresses();
  });

  const fail = (address: string, times: number, at: Date = AT) => {
    for (let attempt = 0; attempt < times; attempt += 1) {
      countUnknownAddressFailure(address, POLICY, at);
    }
  };

  it("locks at the instance's count of failures, and not before", () => {
    fail("nobody@example.org", 2);
    expect(unknownAddressLocked("nobody@example.org", POLICY, AT)).toBe(false);
    fail("nobody@example.org", 1);
    expect(unknownAddressLocked("nobody@example.org", POLICY, AT)).toBe(true);
    // The same address, however it is typed; no other.
    expect(unknownAddressLocked(" Nobody@Example.org ", POLICY, AT)).toBe(true);
    expect(unknownAddressLocked("someone@example.org", POLICY, AT)).toBe(false);
  });

  it("lasts as the instance says, then starts its count over", () => {
    fail("nobody@example.org", 3);
    expect(unknownAddressLocked("nobody@example.org", POLICY, later(14))).toBe(
      true,
    );
    expect(unknownAddressLocked("nobody@example.org", POLICY, later(15))).toBe(
      false,
    );
    // Two more failures are not three: the count began again.
    fail("nobody@example.org", 2, later(16));
    expect(unknownAddressLocked("nobody@example.org", POLICY, later(16))).toBe(
      false,
    );
  });

  it("stays until the process ends where a lock waits for an administrator", () => {
    const forever = { lockoutThreshold: 3, lockoutMinutes: 0 };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      countUnknownAddressFailure("nobody@example.org", forever, AT);
    }
    expect(
      unknownAddressLocked("nobody@example.org", forever, later(100_000)),
    ).toBe(true);
  });

  it("forgets the oldest addresses past what it keeps", () => {
    fail("first@example.org", 3);
    for (let index = 0; index < 20_000; index += 1) {
      countUnknownAddressFailure(`n${String(index)}@example.org`, POLICY, AT);
    }
    expect(unknownAddressLocked("first@example.org", POLICY, AT)).toBe(false);
    expect(unknownAddressLocked("n19999@example.org", POLICY, AT)).toBe(false);
    fail("n19999@example.org", 2);
    expect(unknownAddressLocked("n19999@example.org", POLICY, AT)).toBe(true);
  });
});
