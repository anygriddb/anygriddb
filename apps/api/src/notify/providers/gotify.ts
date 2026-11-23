import {
  gotifyConfigSchema,
  gotifySecretsSchema,
  instanceEventText,
  trimEndRun,
} from "@anygriddb/core";
import type { Outbound, OutboundResponse } from "../outbound.js";
import type { NotifyPayload } from "./webhook.js";

/** POST `{url}/message` with the application token. */
export async function sendGotify(input: {
  config: unknown;
  secrets: unknown;
  event: NotifyPayload;
  send: Outbound;
  allowPrivate: boolean;
  mail?: unknown;
}): Promise<OutboundResponse> {
  const config = gotifyConfigSchema.parse(input.config);
  const secrets = gotifySecretsSchema.parse(input.secrets);
  const text = instanceEventText(input.event);
  const priority =
    input.event.type.endsWith(".failed") ||
    input.event.type === "integration.failing"
      ? 8
      : 5;
  return input.send(
    {
      url: `${trimEndRun(config.url, "/")}/message`,
      method: "POST",
      body: JSON.stringify({
        title: text.title,
        message: text.body,
        priority,
      }),
      headers: {
        "content-type": "application/json",
        "X-Gotify-Key": secrets.token,
      },
    },
    input.allowPrivate,
  );
}

export function gotifyTargets(config: unknown): string[] {
  const parsed = gotifyConfigSchema.safeParse(config);
  return parsed.success ? [parsed.data.url] : [];
}
