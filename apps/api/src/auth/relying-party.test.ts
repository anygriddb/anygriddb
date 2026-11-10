import { describe, expect, it } from "vitest";
import { passkeysEligible, relyingParty } from "./relying-party.js";

describe("relyingParty", () => {
  it("accepts localhost and HTTPS hostnames", () => {
    expect(relyingParty("http://localhost:3000")).toEqual({
      rpID: "localhost",
      origin: "http://localhost:3000",
    });
    expect(relyingParty("https://grid.example.org")).toEqual({
      rpID: "grid.example.org",
      origin: "https://grid.example.org",
    });
    expect(relyingParty("https://grid.lan:3000")).toEqual({
      rpID: "grid.lan",
      origin: "https://grid.lan:3000",
    });
  });

  it("rejects an unparsed origin, plain HTTP off loopback, and IP hosts", () => {
    expect(() => relyingParty("not a url")).toThrow(/Invalid origin/);
    expect(() => relyingParty("http://example.com")).toThrow(/Invalid origin/);
    // Passkeys need a DNS name: browsers refuse a bare IP as RP ID.
    expect(() => relyingParty("https://192.168.1.17:3000")).toThrow(
      /Invalid origin/,
    );
    expect(() => relyingParty("https://[::1]:3000")).toThrow(/Invalid origin/);
    expect(() => relyingParty("https://[2001:db8::1]:3000")).toThrow(
      /Invalid origin/,
    );
  });
});

describe("passkeysEligible", () => {
  it("is true for localhost and DNS hostnames", () => {
    expect(passkeysEligible("http://localhost:3000")).toBe(true);
    expect(passkeysEligible("https://grid.example.org")).toBe(true);
    expect(passkeysEligible("https://grid.lan:3000")).toBe(true);
  });

  it("is false for IP hosts and invalid origins", () => {
    expect(passkeysEligible("https://192.168.1.17:3000")).toBe(false);
    expect(passkeysEligible("https://[::1]:3000")).toBe(false);
    expect(passkeysEligible("http://example.com")).toBe(false);
    expect(passkeysEligible("not a url")).toBe(false);
  });
});
