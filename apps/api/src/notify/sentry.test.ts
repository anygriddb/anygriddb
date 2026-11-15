import { describe, expect, it } from "vitest";
import { buildSentryEnvelope, sendSentry } from "./sentry";

describe("sentry envelope", () => {
  it("posts the project store without the key in the address", () => {
    const envelope = buildSentryEnvelope(
      "https://publickey@errors.example.com/12",
      new Date("2026-11-15T18:00:00.000Z"),
      "aabbccddeeff00112233445566778899",
    );
    expect(envelope?.url).toBe("https://errors.example.com/api/12/envelope/");
    expect(envelope?.auth).toBe(
      "Sentry sentry_version=7, sentry_key=publickey",
    );
    expect(envelope?.body).toContain("internal");
    expect(envelope?.body).not.toContain("@");
    expect(envelope?.body).not.toContain("publickey");
  });

  it("refuses a DSN that is not HTTPS or has no project", () => {
    expect(
      buildSentryEnvelope(
        "http://publickey@errors.example.com/12",
        new Date(),
        "aabbccddeeff00112233445566778899",
      ),
    ).toBeUndefined();
    expect(
      buildSentryEnvelope(
        "https://errors.example.com/12",
        new Date(),
        "aabbccddeeff00112233445566778899",
      ),
    ).toBeUndefined();
  });

  it("sends the envelope through the given transport", async () => {
    let auth = "";
    const response = await sendSentry({
      secrets: { dsn: "https://publickey@errors.example.com/12" },
      event: {
        id: "00000000-0000-4000-8000-000000000001",
        type: "test",
        at: "2026-11-15T18:00:00.000Z",
        subject: "test",
        fields: {},
      },
      allowPrivate: false,
      send: (request) => {
        auth = request.headers?.["x-sentry-auth"] ?? "";
        expect(request.url).toBe("https://errors.example.com/api/12/envelope/");
        return Promise.resolve({ status: 200, body: "" });
      },
    });
    expect(response.status).toBe(200);
    expect(auth).toContain("sentry_key=publickey");
  });
});
