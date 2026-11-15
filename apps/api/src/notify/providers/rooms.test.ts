import { describe, expect, it } from "vitest";
import {
  sendAlertmanager,
  sendMattermost,
  sendMatrix,
  sendZulip,
} from "./rooms";

const event = {
  id: "00000000-0000-4000-8000-000000000001",
  type: "job.failed",
  at: "2026-11-15T18:00:00.000Z",
  subject: "job-1",
  fields: { kind: "export", code: "internal_error" },
};

describe("room channels", () => {
  it("puts a Matrix message in the room, once per event", async () => {
    let seen: { url?: string; method?: string; body?: string; auth?: string } =
      {};
    await sendMatrix({
      config: {
        homeserver: "https://matrix.example.com",
        roomId: "!room:example.com",
      },
      secrets: { accessToken: "a-long-enough-secret" },
      event,
      allowPrivate: false,
      send: (request) => {
        seen = {
          url: request.url,
          method: request.method,
          body: request.body,
          auth: request.headers?.authorization,
        };
        return Promise.resolve({ status: 200, body: "{}" });
      },
    });
    expect(seen.method).toBe("PUT");
    expect(seen.url).toBe(
      "https://matrix.example.com/_matrix/client/v3/rooms/!room%3Aexample.com/send/m.room.message/00000000-0000-4000-8000-000000000001",
    );
    expect(seen.auth).toBe("Bearer a-long-enough-secret");
    expect(JSON.parse(seen.body ?? "")).toMatchObject({ msgtype: "m.text" });
  });

  it("refuses a Matrix homeserver that is not HTTPS", async () => {
    await expect(
      sendMatrix({
        config: { homeserver: "http://matrix.example.com", roomId: "!room" },
        secrets: { accessToken: "a-long-enough-secret" },
        event,
        allowPrivate: false,
        send: () => Promise.resolve({ status: 200, body: "" }),
      }),
    ).rejects.toThrow();
  });

  it("posts Mattermost text", async () => {
    let body = "";
    await sendMattermost({
      config: {},
      secrets: { webhookUrl: "https://chat.example.com/hooks/abcdef" },
      event,
      allowPrivate: false,
      send: (request) => {
        body = request.body ?? "";
        return Promise.resolve({ status: 200, body: "ok" });
      },
    });
    expect(JSON.parse(body)).toHaveProperty("text");
  });

  it("posts Zulip as a form field", async () => {
    let seen: { type?: string; body?: string } = {};
    await sendZulip({
      config: {},
      secrets: {
        webhookUrl:
          "https://zulip.example.com/api/v1/external/generic?api_key=abcdef",
      },
      event,
      allowPrivate: false,
      send: (request) => {
        seen = {
          type: request.headers?.["content-type"],
          body: request.body,
        };
        return Promise.resolve({ status: 200, body: "" });
      },
    });
    expect(seen.type).toBe("application/x-www-form-urlencoded");
    expect(seen.body).toContain("content=");
  });

  it("closes an Alertmanager alert when the event recovered", async () => {
    let body = "";
    await sendAlertmanager({
      config: { url: "https://alerts.example.com" },
      secrets: {},
      event: { ...event, type: "datasource.recovered" },
      allowPrivate: false,
      send: (request) => {
        body = request.body ?? "";
        expect(request.url).toBe("https://alerts.example.com/api/v2/alerts");
        return Promise.resolve({ status: 200, body: "" });
      },
    });
    const sent = JSON.parse(body) as Array<{
      labels: { alertname: string };
      endsAt?: string;
    }>;
    expect(sent[0]?.labels.alertname).toBe("datasource.recovered");
    expect(sent[0]?.endsAt).toBe(event.at);
  });
});
