import { describe, expect, it } from "vitest";
import { sendApprise } from "./apprise";
import { sendGotify } from "./gotify";
import { sendNtfy } from "./ntfy";
import { sendSmtpChannel } from "./smtp";

const event = {
  id: "00000000-0000-4000-8000-000000000001",
  type: "job.failed",
  at: "2026-11-15T18:00:00.000Z",
  subject: "job-1",
  fields: { kind: "export", code: "internal_error" },
};

describe("notification channels", () => {
  it("publishes to an ntfy topic with a bearer token", async () => {
    let url = "";
    let authorization = "";
    await sendNtfy({
      config: { server: "https://ntfy.example.com" },
      secrets: { topic: "ops-topic-1", token: "token-value" },
      event,
      allowPrivate: false,
      send: (request) => {
        url = request.url;
        authorization = request.headers?.Authorization ?? "";
        expect(request.headers?.Priority).toBe("high");
        return Promise.resolve({ status: 200, body: "" });
      },
    });
    expect(url).toBe("https://ntfy.example.com/ops-topic-1");
    expect(authorization).toBe("Bearer token-value");
  });

  it("posts a Gotify message with the application token", async () => {
    let key = "";
    await sendGotify({
      config: { url: "https://gotify.example.com" },
      secrets: { token: "app-token" },
      event,
      allowPrivate: false,
      send: (request) => {
        key = request.headers?.["X-Gotify-Key"] ?? "";
        expect(request.url).toBe("https://gotify.example.com/message");
        expect(request.body).toContain('"priority":8');
        return Promise.resolve({ status: 200, body: "" });
      },
    });
    expect(key).toBe("app-token");
  });

  it("posts Apprise stateless urls and a failure type", async () => {
    let body = "";
    await sendApprise({
      config: { url: "https://apprise.example.com/" },
      secrets: {
        urls: "mailto://alerts@example.com",
        username: "api",
        password: "secret-value",
      },
      event,
      allowPrivate: false,
      send: (request) => {
        body = request.body ?? "";
        expect(request.url).toBe("https://apprise.example.com/notify");
        expect(request.headers?.Authorization?.startsWith("Basic ")).toBe(true);
        return Promise.resolve({ status: 200, body: "" });
      },
    });
    expect(body).toContain('"type":"failure"');
    expect(body).toContain("mailto://alerts@example.com");
  });

  it("mails each recipient, and refuses when the relay is not set", async () => {
    const sent: string[] = [];
    await sendSmtpChannel({
      config: { recipients: ["one@example.com", "two@example.com"] },
      event,
      mail: (message) => {
        sent.push(message.to);
        return Promise.resolve();
      },
    });
    expect(sent).toEqual(["one@example.com", "two@example.com"]);
    await expect(
      sendSmtpChannel({
        config: { recipients: ["one@example.com"] },
        event,
      }),
    ).rejects.toMatchObject({ code: "notify_needs_mail" });
  });
});
