import { describe, expect, it } from "vitest";
import {
  assertPublicHttps,
  failureText,
  guardedLookup,
  isBlockedAddress,
  payloadRow,
  planAttempt,
  postPinned,
  signBody,
} from "./webhooks.js";

describe("webhooks", () => {
  it("signs the body and rejects a private target", async () => {
    expect(signBody("secret", '{"ok":true}')).toMatch(/^[a-f0-9]{64}$/);
    await expect(assertPublicHttps("http://example.com/hook")).rejects.toThrow(
      /Invalid webhook/,
    );
    await expect(assertPublicHttps("https://127.0.0.1/hook")).rejects.toThrow(
      /Invalid webhook/,
    );
    await expect(assertPublicHttps("https://localhost/hook")).rejects.toThrow(
      /Invalid webhook/,
    );
  });
});

describe("isBlockedAddress", () => {
  it("blocks private, loopback, link-local, and mapped addresses", () => {
    for (const [address, family] of [
      ["10.1.2.3", 4],
      ["100.64.0.1", 4],
      ["169.254.169.254", 4],
      ["192.168.1.1", 4],
      ["::1", 6],
      ["fd00::1", 6],
      ["fec0::1", 6],
      ["2002:c000:201::1", 6],
      ["2001:0:4136:e378::1", 6],
      ["64:ff9b:1::1", 6],
      ["::ffff:127.0.0.1", 6],
      ["::ffff:7f00:1", 6],
      ["::ffff:a9fe:a9fe", 6],
    ] as const) {
      expect(isBlockedAddress(address, family), address).toBe(true);
    }
  });

  it("allows public addresses", () => {
    expect(isBlockedAddress("93.184.216.34", 4)).toBe(false);
    expect(isBlockedAddress("2606:4700::1111", 6)).toBe(false);
    expect(isBlockedAddress("::ffff:93.184.216.34", 6)).toBe(false);
  });
});

describe("guardedLookup", () => {
  it("refuses a name that resolves to a private address", async () => {
    const error = await new Promise<unknown>((resolve) => {
      guardedLookup("localhost", { all: true }, (failure) => resolve(failure));
    });
    expect(error).toBeInstanceOf(Error);
    expect(failureText(error)).toBe("Blocked target");
  });

  it("refuses private literals before connecting", async () => {
    await expect(postPinned("https://10.0.0.1/hook", "{}", {})).rejects.toThrow(
      "Invalid webhook",
    );
  });
});

describe("planAttempt", () => {
  it("clears the payload on success", () => {
    expect(planAttempt(true, 1)).toEqual({
      status: "success",
      clearPayload: true,
    });
  });

  it("retries three times, then fails", () => {
    expect(planAttempt(false, 1)).toEqual({
      status: "pending",
      retryInSeconds: 60,
    });
    expect(planAttempt(false, 3)).toEqual({
      status: "pending",
      retryInSeconds: 1_800,
    });
    expect(planAttempt(false, 4)).toEqual({ status: "failed" });
  });
});

describe("failureText", () => {
  it("names failures without internal details", () => {
    expect(failureText(new Error("HTTP 503"))).toBe("HTTP 503");
    expect(
      failureText(Object.assign(new Error("x"), { code: "ECONNREFUSED" })),
    ).toBe("Connection refused");
    expect(failureText(new Error("socket hang up at 10.0.0.3"))).toBe(
      "Network error",
    );
  });
});

describe("payloadRow", () => {
  it("keeps fields and the status, drops system columns", () => {
    expect(
      payloadRow({
        id: "r1",
        ag_status: "draft",
        ag_seq: 4,
        nom: "Acme",
        montant: 3,
      }),
    ).toEqual({
      id: "r1",
      status: "draft",
      fields: { nom: "Acme", montant: 3 },
    });
  });
});
