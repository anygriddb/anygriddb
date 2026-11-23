import {
  appriseConfigSchema,
  appriseSecretsSchema,
  instanceEventText,
  trimEndRun,
} from "@anygriddb/core";
import type { Outbound, OutboundResponse } from "../outbound.js";
import type { NotifyPayload } from "./webhook.js";

function noticeType(type: string): "failure" | "success" | "warning" | "info" {
  if (
    type.endsWith(".failed") ||
    type === "integration.failing" ||
    type === "migration.failed"
  ) {
    return "failure";
  }
  if (type.endsWith(".succeeded") || type === "datasource.recovered")
    return "success";
  if (type === "disk.low" || type === "auth.login_failed_burst")
    return "warning";
  return "info";
}

/** POST `{url}/notify`. The destination URLs stay in the body, sealed. */
export async function sendApprise(input: {
  config: unknown;
  secrets: unknown;
  event: NotifyPayload;
  send: Outbound;
  allowPrivate: boolean;
  mail?: unknown;
}): Promise<OutboundResponse> {
  const config = appriseConfigSchema.parse(input.config);
  const secrets = appriseSecretsSchema.parse(input.secrets);
  const text = instanceEventText(input.event);
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (secrets.username && secrets.password) {
    const token = Buffer.from(
      `${secrets.username}:${secrets.password}`,
    ).toString("base64");
    headers.Authorization = `Basic ${token}`;
  }
  return input.send(
    {
      url: `${trimEndRun(config.url, "/")}/notify`,
      method: "POST",
      body: JSON.stringify({
        urls: secrets.urls,
        title: text.title,
        body: text.body,
        type: noticeType(input.event.type),
      }),
      headers,
    },
    input.allowPrivate,
  );
}

export function appriseTargets(config: unknown): string[] {
  const parsed = appriseConfigSchema.safeParse(config);
  return parsed.success ? [parsed.data.url] : [];
}
