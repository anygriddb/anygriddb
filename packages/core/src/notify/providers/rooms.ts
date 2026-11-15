import { z } from "zod";
import type { NotifyProvider } from "../provider";

const httpsUrl = z
  .string()
  .trim()
  .max(2_000)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password;
    } catch {
      return false;
    }
  });

function channel(
  id: string,
  label: string,
  docsUrl: string,
  fields: NotifyProvider["fields"],
  config: z.ZodType,
  secrets: z.ZodType,
): NotifyProvider {
  return {
    id,
    family: "channel",
    label,
    docsUrl,
    subscribes: true,
    singleton: false,
    fields,
    config,
    secrets,
  };
}

export const matrixConfigSchema = z
  .object({
    homeserver: httpsUrl,
    roomId: z.string().trim().min(1).max(200),
  })
  .strict();
export const matrixSecretsSchema = z
  .object({ accessToken: z.string().min(1).max(500) })
  .strict();

export const incomingUrlSecretsSchema = z
  .object({ webhookUrl: httpsUrl })
  .strict();

export const alertmanagerConfigSchema = z.object({ url: httpsUrl }).strict();
export const alertmanagerSecretsSchema = z
  .object({
    username: z.string().trim().min(1).max(200).optional(),
    password: z.string().min(1).max(200).optional(),
  })
  .strict();

export const matrixProvider = channel(
  "matrix",
  "Matrix",
  "https://spec.matrix.org/latest/client-server-api/#put_matrixclientv3roomsroomidsendeventtypetxnid",
  [
    { key: "homeserver", kind: "url", required: true, secret: false },
    { key: "roomId", kind: "text", required: true, secret: false },
    { key: "accessToken", kind: "secret", required: true, secret: true },
  ],
  matrixConfigSchema,
  matrixSecretsSchema,
);

export const mattermostProvider = channel(
  "mattermost",
  "Mattermost",
  "https://developers.mattermost.com/integrate/webhooks/incoming/",
  [{ key: "webhookUrl", kind: "secret", required: true, secret: true }],
  z.object({}).strict(),
  incomingUrlSecretsSchema,
);

export const rocketchatProvider = channel(
  "rocketchat",
  "Rocket.Chat",
  "https://docs.rocket.chat/docs/incoming-webhooks",
  [{ key: "webhookUrl", kind: "secret", required: true, secret: true }],
  z.object({}).strict(),
  incomingUrlSecretsSchema,
);

export const zulipProvider = channel(
  "zulip",
  "Zulip",
  "https://zulip.com/integrations/doc/generic",
  [{ key: "webhookUrl", kind: "secret", required: true, secret: true }],
  z.object({}).strict(),
  incomingUrlSecretsSchema,
);

export const alertmanagerProvider = channel(
  "alertmanager",
  "Alertmanager",
  "https://prometheus.io/docs/alerting/latest/alerts_api/",
  [
    { key: "url", kind: "url", required: true, secret: false },
    { key: "username", kind: "secret", required: false, secret: true },
    { key: "password", kind: "secret", required: false, secret: true },
  ],
  alertmanagerConfigSchema,
  alertmanagerSecretsSchema,
);
