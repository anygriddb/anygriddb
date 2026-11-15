import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { sendWebhook, webhookBody } from "./webhook";

describe("webhook delivery", () => {
  const event = {
    id: "00000000-0000-4000-8000-000000000001",
    type: "job.failed",
    at: "2026-11-15T18:00:00.000Z",
    subject: "job-1",
    fields: { kind: "export", code: "internal_error" },
  };
  const secret = "a-long-enough-secret";

  it("posts the event as JSON and signs those bytes", async () => {
    let seen: { url?: string; body?: string; signature?: string } = {};
    const response = await sendWebhook({
      config: { url: "https://hooks.example.com/in" },
      secrets: { secret, headers: { "X-Token": "abcdefghi" } },
      event,
      allowPrivate: false,
      send: (request) => {
        seen = {
          url: request.url,
          body: request.body,
          signature: request.headers?.["x-anygrid-signature"],
        };
        expect(request.headers?.["content-type"]).toBe("application/json");
        expect(request.headers?.["X-Token"]).toBe("abcdefghi");
        return Promise.resolve({ status: 204, body: "" });
      },
    });
    const body = webhookBody(event);
    expect(seen.body).toBe(body);
    expect(seen.signature).toBe(
      `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
    );
    expect(seen.url).toBe("https://hooks.example.com/in");
    expect(response.status).toBe(204);
  });

  it("refuses a secret that is too short to sign with", async () => {
    await expect(
      sendWebhook({
        config: { url: "https://hooks.example.com/in" },
        secrets: { secret: "short" },
        event,
        allowPrivate: false,
        send: () => Promise.resolve({ status: 200, body: "" }),
      }),
    ).rejects.toThrow();
  });
});
