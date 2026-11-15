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

/** Topic names ntfy accepts. The topic is the credential. */
const topic = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

export const ntfyConfigSchema = z.object({ server: httpsUrl }).strict();
export const ntfySecretsSchema = z
  .object({
    topic,
    token: z.string().min(1).max(200).optional(),
  })
  .strict();

export const ntfyProvider: NotifyProvider = {
  id: "ntfy",
  family: "channel",
  label: "ntfy",
  docsUrl: "https://docs.ntfy.sh/publish/",
  subscribes: true,
  singleton: false,
  fields: [
    { key: "server", kind: "url", required: true, secret: false },
    { key: "topic", kind: "secret", required: true, secret: true },
    { key: "token", kind: "secret", required: false, secret: true },
  ],
  config: ntfyConfigSchema,
  secrets: ntfySecretsSchema,
};
