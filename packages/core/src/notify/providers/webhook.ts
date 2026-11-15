import { z } from "zod";
import type { NotifyProvider } from "../provider";

/** A header an administrator may set. Hop-by-hop names are refused. */
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;

const FORBIDDEN_HEADERS = new Set([
  "connection",
  "content-length",
  "content-type",
  "host",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "x-anygrid-signature",
]);

const headersSchema = z
  .record(z.string().regex(HEADER_NAME), z.string().max(500))
  .refine((headers) => Object.keys(headers).length <= 20, {
    message: "too many headers",
  })
  .refine(
    (headers) =>
      Object.keys(headers).every(
        (name) => !FORBIDDEN_HEADERS.has(name.toLowerCase()),
      ),
    { message: "reserved header" },
  );

export const webhookConfigSchema = z
  .object({
    url: z
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
      }),
  })
  .strict();

export const webhookSecretsSchema = z
  .object({
    secret: z.string().min(16).max(200),
    headers: headersSchema.optional(),
  })
  .strict();

export type WebhookConfig = z.infer<typeof webhookConfigSchema>;
export type WebhookSecrets = z.infer<typeof webhookSecretsSchema>;

/** A JSON POST whose body is signed with HMAC-SHA256. */
export const webhookProvider: NotifyProvider = {
  id: "webhook",
  family: "channel",
  label: "Webhook",
  docsUrl:
    "https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Methods/POST",
  subscribes: true,
  singleton: false,
  fields: [
    { key: "url", kind: "url", required: true, secret: false },
    { key: "secret", kind: "secret", required: true, secret: true },
    { key: "headers", kind: "headers", required: false, secret: true },
  ],
  config: webhookConfigSchema,
  secrets: webhookSecretsSchema,
};
