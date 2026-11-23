import {
  instanceEventText,
  ntfyConfigSchema,
  ntfySecretsSchema,
  trimEndRun,
} from "@anygriddb/core";
import type { Outbound, OutboundResponse } from "../outbound.js";
import type { NotifyPayload } from "./webhook.js";

function priority(type: string): string {
  if (
    type.endsWith(".failed") ||
    type === "integration.failing" ||
    type === "disk.low" ||
    type === "auth.login_failed_burst" ||
    type === "datasource.unreachable" ||
    type === "migration.failed"
  ) {
    return "high";
  }
  return "default";
}

/** POST `{server}/{topic}` with the message as the body. */
export async function sendNtfy(input: {
  config: unknown;
  secrets: unknown;
  event: NotifyPayload;
  send: Outbound;
  allowPrivate: boolean;
  mail?: unknown;
}): Promise<OutboundResponse> {
  const config = ntfyConfigSchema.parse(input.config);
  const secrets = ntfySecretsSchema.parse(input.secrets);
  const text = instanceEventText(input.event);
  const server = trimEndRun(config.server, "/");
  const headers: Record<string, string> = {
    Title: text.title,
    Priority: priority(input.event.type),
  };
  if (secrets.token) headers.Authorization = `Bearer ${secrets.token}`;
  return input.send(
    {
      url: `${server}/${secrets.topic}`,
      method: "POST",
      body: text.body,
      headers,
    },
    input.allowPrivate,
  );
}

export function ntfyTargets(config: unknown): string[] {
  const parsed = ntfyConfigSchema.safeParse(config);
  return parsed.success ? [parsed.data.server] : [];
}
