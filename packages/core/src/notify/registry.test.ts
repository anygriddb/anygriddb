import { describe, expect, it } from "vitest";
import { instanceEventText, jobEventType } from "./events";
import { rateDecision } from "./rate";
import { parseProviderConfig } from "./registry";

describe("notification events", () => {
  it("describes a failed job without a row or an address", () => {
    const text = instanceEventText({
      type: "job.failed",
      subject: "job-1",
      fields: { kind: "export", code: "internal_error" },
    });
    expect(text.title).toBe("A background job failed");
    expect(text.body).toContain("job-1");
    expect(text.body).not.toMatch(/@/);
  });

  it("uses one event for an import, and another for any other job", () => {
    expect(jobEventType("import", "failed")).toBe("import.failed");
    expect(jobEventType("export", "failed")).toBe("job.failed");
    expect(jobEventType("export", "done")).toBe("job.succeeded");
  });
});

describe("notification rate", () => {
  const now = 1_700_000_000_000;

  it("sends the first event and counts it", () => {
    expect(
      rateDecision(
        { now, windowStartedAt: null, sent: 0, lastSameAt: null },
        0,
      ),
    ).toMatchObject({ action: "send", sent: 1, suppressed: 0 });
  });

  it("suppresses the same subject inside five minutes, and the 21st send", () => {
    expect(
      rateDecision(
        { now, windowStartedAt: now, sent: 1, lastSameAt: now - 60_000 },
        0,
      ).action,
    ).toBe("suppress");
    expect(
      rateDecision(
        { now, windowStartedAt: now, sent: 20, lastSameAt: null },
        3,
      ),
    ).toMatchObject({ action: "suppress", sent: 20, suppressed: 4 });
  });

  it("starts a new hour", () => {
    const decision = rateDecision(
      {
        now,
        windowStartedAt: now - 61 * 60 * 1000,
        sent: 20,
        lastSameAt: now - 61 * 60 * 1000,
      },
      9,
    );
    expect(decision).toMatchObject({
      action: "send",
      sent: 1,
      suppressed: 0,
      reset: true,
    });
  });
});

describe("webhook configuration", () => {
  const secrets = { secret: "a-long-enough-secret" };

  it("accepts an https address and a signing secret", () => {
    expect(
      parseProviderConfig(
        "webhook",
        { url: "https://hooks.example.com/in" },
        secrets,
      ).config,
    ).toEqual({ url: "https://hooks.example.com/in" });
  });

  it("refuses a clear-text address, a short secret, and an unknown tool", () => {
    const code = (body: () => unknown) => {
      try {
        body();
      } catch (error) {
        return (error as { code?: string }).code;
      }
      return undefined;
    };
    expect(
      code(() =>
        parseProviderConfig(
          "webhook",
          { url: "http://hooks.example.com/in" },
          secrets,
        ),
      ),
    ).toBe("invalid_integration");
    expect(
      code(() =>
        parseProviderConfig(
          "webhook",
          { url: "https://hooks.example.com/in" },
          { secret: "short" },
        ),
      ),
    ).toBe("invalid_integration");
    expect(code(() => parseProviderConfig("nope", {}, {}))).toBe(
      "invalid_integration",
    );
  });
});
