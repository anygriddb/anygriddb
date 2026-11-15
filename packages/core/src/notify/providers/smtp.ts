import { z } from "zod";
import type { NotifyProvider } from "../provider";

export const smtpChannelConfigSchema = z
  .object({
    recipients: z.array(z.email().max(254)).min(1).max(10),
  })
  .strict();

const smtpChannelSecretsSchema = z.object({}).strict();

/** Mail through the relay already configured under Connections. */
export const smtpChannelProvider: NotifyProvider = {
  id: "smtp",
  family: "channel",
  label: "Email",
  docsUrl: "https://datatracker.ietf.org/doc/html/rfc5321",
  subscribes: true,
  singleton: false,
  fields: [
    { key: "recipients", kind: "strings", required: true, secret: false },
  ],
  config: smtpChannelConfigSchema,
  secrets: smtpChannelSecretsSchema,
};
