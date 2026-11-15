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

export const heartbeatSecretsSchema = z
  .object({
    pingUrl: httpsUrl.optional(),
    pushUrl: httpsUrl.optional(),
    startUrl: httpsUrl.optional(),
    successUrl: httpsUrl.optional(),
    failUrl: httpsUrl.optional(),
  })
  .strict();

function heartbeat(
  id: string,
  label: string,
  docsUrl: string,
  fields: NotifyProvider["fields"],
  secrets: z.ZodType,
): NotifyProvider {
  return {
    id,
    family: "heartbeat",
    label,
    docsUrl,
    subscribes: false,
    singleton: false,
    fields,
    config: z.object({}).strict(),
    secrets,
  };
}

export const healthchecksProvider = heartbeat(
  "healthchecks",
  "Healthchecks",
  "https://healthchecks.io/docs/http_api/",
  [{ key: "pingUrl", kind: "secret", required: true, secret: true }],
  heartbeatSecretsSchema.refine((value) => Boolean(value.pingUrl)),
);

export const uptimeKumaProvider = heartbeat(
  "uptime-kuma",
  "Uptime Kuma",
  "https://uptime.kuma.pet/docs/push/",
  [{ key: "pushUrl", kind: "secret", required: true, secret: true }],
  heartbeatSecretsSchema.refine((value) => Boolean(value.pushUrl)),
);

export const genericBeatProvider = heartbeat(
  "heartbeat",
  "Heartbeat URL",
  "https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Methods/GET",
  [
    { key: "startUrl", kind: "secret", required: false, secret: true },
    { key: "successUrl", kind: "secret", required: false, secret: true },
    { key: "failUrl", kind: "secret", required: false, secret: true },
  ],
  heartbeatSecretsSchema.refine((value) =>
    Boolean(value.startUrl || value.successUrl || value.failUrl),
  ),
);
