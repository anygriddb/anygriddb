import { describe, expect, it } from "vitest";
import { heartbeatSecretsSchema } from "@anygriddb/core";
import { heartbeatAccepted, heartbeatTarget } from "./pulse";

describe("heartbeat secrets", () => {
  it("accepts a healthchecks ping address", () => {
    const parsed = heartbeatSecretsSchema.parse({
      pingUrl:
        "https://hc-ping.example.com/11111111-1111-4111-8111-111111111111",
    });
    expect(parsed.pingUrl).toContain("hc-ping.example.com");
  });

  it("pings start, success, and failure on the addresses each tool uses", () => {
    const ping =
      "https://hc-ping.example.com/11111111-1111-4111-8111-111111111111";
    expect(heartbeatTarget("healthchecks", { pingUrl: ping }, "start")).toBe(
      `${ping}/start`,
    );
    expect(heartbeatTarget("healthchecks", { pingUrl: ping }, "success")).toBe(
      ping,
    );
    expect(heartbeatTarget("healthchecks", { pingUrl: ping }, "fail")).toBe(
      `${ping}/fail`,
    );
    const push = heartbeatTarget(
      "uptime-kuma",
      { pushUrl: "https://kuma.example.com/api/push/abcdef" },
      "fail",
    );
    expect(push).toContain("status=down");
    expect(
      heartbeatTarget(
        "heartbeat",
        { successUrl: "https://beat.example.com/ok" },
        "start",
      ),
    ).toBeNull();
  });

  it("treats a Healthchecks body that says not found as a failure", () => {
    expect(
      heartbeatAccepted("healthchecks", { status: 200, body: "not found" }),
    ).toBe(false);
    expect(heartbeatAccepted("healthchecks", { status: 200, body: "ok" })).toBe(
      true,
    );
  });

  it("refuses a clear-text ping address", () => {
    expect(
      heartbeatSecretsSchema.safeParse({
        pingUrl: "http://hc-ping.example.com/x",
      }).success,
    ).toBe(false);
  });
});
