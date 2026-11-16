import { describe, expect, it } from "vitest";
import { returnAddressHost } from "./consent-page";

describe("returnAddressHost", () => {
  const registered = [
    "https://app.example.org/callback",
    "http://127.0.0.1:8123/done",
  ];

  it("gives the host of an address the application registered", () => {
    expect(
      returnAddressHost("https://app.example.org/callback", registered),
    ).toBe("app.example.org");
    expect(returnAddressHost("http://127.0.0.1:8123/done", registered)).toBe(
      "127.0.0.1:8123",
    );
  });

  it("refuses any other address, however close", () => {
    expect(
      returnAddressHost("https://elsewhere.example/callback", registered),
    ).toBeNull();
    expect(
      returnAddressHost("https://app.example.org/callback?x=1", registered),
    ).toBeNull();
    expect(returnAddressHost("javascript:alert(1)//", registered)).toBeNull();
    expect(returnAddressHost("", registered)).toBeNull();
  });
});
