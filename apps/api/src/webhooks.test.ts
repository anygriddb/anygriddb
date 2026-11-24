import { AppError } from "@anygriddb/core";
import { describe, expect, it } from "vitest";
import {
  assertPublicHttps,
  failureText,
  payloadRow,
  planAttempt,
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

  it("refuses a private network, which only an administrator may allow", async () => {
    for (const target of [
      "https://10.0.0.1/hook",
      "https://192.168.1.1/hook",
      "https://[fd00::1]/hook",
    ]) {
      await expect(assertPublicHttps(target), target).rejects.toMatchObject({
        code: "invalid_webhook",
      });
    }
  });

  it("refuses an address it cannot read, as an invalid webhook", async () => {
    for (const target of ["https://", "https:// hooks.example.org", "hooks"]) {
      await expect(assertPublicHttps(target), target).rejects.toMatchObject({
        code: "invalid_webhook",
      });
    }
  });

  it("refuses a name that does not resolve, as an invalid webhook", async () => {
    // `.invalid` never resolves (RFC 6761), with or without a network.
    await expect(
      assertPublicHttps("https://hooks.invalid/hook"),
    ).rejects.toMatchObject({ code: "invalid_webhook" });
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
  it("says a delivery by mail failed for want of a mail server", () => {
    expect(failureText(new AppError("invalid_webhook"))).toBe(
      "Invalid email settings",
    );
    expect(failureText(new AppError("invalid_outbound_target"))).toBe(
      "Blocked target",
    );
  });

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
