import {
  alertmanagerConfigSchema,
  alertmanagerSecretsSchema,
  incomingUrlSecretsSchema,
  instanceEventText,
  matrixConfigSchema,
  matrixSecretsSchema,
} from "@anygriddb/core";
import type { Outbound, OutboundResponse } from "../outbound.js";
import type { NotifyPayload } from "./webhook.js";

type SendInput = {
  config: unknown;
  secrets: unknown;
  event: NotifyPayload;
  send: Outbound;
  allowPrivate: boolean;
  mail?: unknown;
};

function textOf(event: NotifyPayload): string {
  const text = instanceEventText(event);
  return `${text.title}\n\n${text.body}`;
}

export async function sendMatrix(input: SendInput): Promise<OutboundResponse> {
  const config = matrixConfigSchema.parse(input.config);
  const secrets = matrixSecretsSchema.parse(input.secrets);
  const text = instanceEventText(input.event);
  const room = encodeURIComponent(config.roomId);
  const base = config.homeserver.replace(/\/+$/, "");
  return input.send(
    {
      url: `${base}/_matrix/client/v3/rooms/${room}/send/m.room.message/${input.event.id}`,
      method: "PUT",
      body: JSON.stringify({
        msgtype: "m.text",
        body: `${text.title}\n\n${text.body}`,
      }),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${secrets.accessToken}`,
      },
    },
    input.allowPrivate,
  );
}

async function postText(
  input: SendInput,
  body: string,
  contentType: string,
): Promise<OutboundResponse> {
  const secrets = incomingUrlSecretsSchema.parse(input.secrets);
  return input.send(
    {
      url: secrets.webhookUrl,
      method: "POST",
      body,
      headers: { "content-type": contentType },
    },
    input.allowPrivate,
  );
}

export function sendMattermost(input: SendInput): Promise<OutboundResponse> {
  return postText(
    input,
    JSON.stringify({ text: textOf(input.event) }),
    "application/json",
  );
}

export function sendRocketChat(input: SendInput): Promise<OutboundResponse> {
  return postText(
    input,
    JSON.stringify({ text: textOf(input.event) }),
    "application/json",
  );
}

export function sendZulip(input: SendInput): Promise<OutboundResponse> {
  const body = new URLSearchParams({ content: textOf(input.event) }).toString();
  return postText(input, body, "application/x-www-form-urlencoded");
}

export async function sendAlertmanager(
  input: SendInput,
): Promise<OutboundResponse> {
  const config = alertmanagerConfigSchema.parse(input.config);
  const secrets = alertmanagerSecretsSchema.parse(input.secrets);
  const text = instanceEventText(input.event);
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (secrets.username && secrets.password) {
    headers.authorization = `Basic ${Buffer.from(`${secrets.username}:${secrets.password}`).toString("base64")}`;
  }
  const resolved =
    input.event.type.endsWith(".recovered") ||
    input.event.type.endsWith(".succeeded");
  return input.send(
    {
      url: `${config.url.replace(/\/+$/, "")}/api/v2/alerts`,
      method: "POST",
      headers,
      body: JSON.stringify([
        {
          labels: { alertname: input.event.type, subject: input.event.subject },
          annotations: { summary: text.title, description: text.body },
          startsAt: input.event.at,
          ...(resolved ? { endsAt: input.event.at } : {}),
        },
      ]),
    },
    input.allowPrivate,
  );
}

export function matrixTargets(config: unknown): string[] {
  const parsed = matrixConfigSchema.safeParse(config);
  return parsed.success ? [parsed.data.homeserver] : [];
}

export function alertmanagerTargets(config: unknown): string[] {
  const parsed = alertmanagerConfigSchema.safeParse(config);
  return parsed.success ? [parsed.data.url] : [];
}
