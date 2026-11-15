import {
  AppError,
  instanceEventText,
  smtpChannelConfigSchema,
} from "@anygriddb/core";
import type { OutboundResponse } from "../outbound.js";
import type { NotifyPayload } from "./webhook.js";

/** One mail per recipient, through the instance relay. */
export async function sendSmtpChannel(input: {
  config: unknown;
  secrets?: unknown;
  event: NotifyPayload;
  send?: unknown;
  allowPrivate?: boolean;
  mail?: (message: {
    to: string;
    subject: string;
    text: string;
  }) => Promise<void>;
}): Promise<OutboundResponse> {
  const config = smtpChannelConfigSchema.parse(input.config);
  if (!input.mail) throw new AppError("notify_needs_mail");
  const text = instanceEventText(input.event);
  for (const to of config.recipients) {
    await input.mail({ to, subject: text.title, text: text.body });
  }
  return { status: 202, body: "" };
}
