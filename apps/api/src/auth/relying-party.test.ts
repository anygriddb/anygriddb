import { describe, expect, it } from "vitest";
import { relyingParty } from "./relying-party.js";

describe("relyingParty", () => {
  it("accepts localhost and rejects an unparsed origin", () => {
    expect(relyingParty("http://localhost:3000")).toEqual({
      rpID: "localhost",
      origin: "http://localhost:3000",
    });
    expect(() => relyingParty("not a url")).toThrow(/Invalid origin/);
    expect(() => relyingParty("http://example.com")).toThrow(/Invalid origin/);
  });
});
