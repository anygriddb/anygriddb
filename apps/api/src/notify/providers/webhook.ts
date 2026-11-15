import { createHmac } from "node:crypto";
import { webhookConfigSchema, webhookSecretsSchema } from "@anygriddb/core";
import type { Outbound, OutboundResponse } from "../outbound.js";

export type NotifyPayload = {
  id: string;
  type: string;
  at: string;
  subject: string;
  fields: Record<string, string | number | boolean>;
};

/** The JSON a webhook receives, signed over the exact bytes. */
export function webhookBody(event: NotifyPayload): string {
  return JSON.stringify({
    id: event.id,
    type: event.type,
    at: event.at,
    subject: event.subject,
    fields: event.fields,
  });
}

export function signWebhook(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

export async function sendWebhook(input: {
  config: unknown;
  secrets: unknown;
  event: NotifyPayload;
  send: Outbound;
  allowPrivate: boolean;
  mail?: unknown;
}): Promise<OutboundResponse> {
  const config = webhookConfigSchema.parse(input.config);
  const secrets = webhookSecretsSchema.parse(input.secrets);
  const body = webhookBody(input.event);
  return input.send(
    {
      url: config.url,
      method: "POST",
      body,
      headers: {
        ...(secrets.headers ?? {}),
        "content-type": "application/json",
        "x-anygrid-signature": `sha256=${signWebhook(secrets.secret, body)}`,
      },
    },
    input.allowPrivate,
  );
}

export function webhookTargets(config: unknown): string[] {
  const parsed = webhookConfigSchema.safeParse(config);
  return parsed.success ? [parsed.data.url] : [];
}
