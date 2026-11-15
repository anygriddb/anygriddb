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

export const appriseConfigSchema = z.object({ url: httpsUrl }).strict();
export const appriseSecretsSchema = z
  .object({
    urls: z.string().trim().min(1).max(4_000),
    username: z.string().trim().min(1).max(200).optional(),
    password: z.string().min(1).max(200).optional(),
  })
  .strict();

export const appriseProvider: NotifyProvider = {
  id: "apprise",
  family: "channel",
  label: "Apprise",
  docsUrl: "https://github.com/caronc/apprise-api",
  subscribes: true,
  singleton: false,
  fields: [
    { key: "url", kind: "url", required: true, secret: false },
    { key: "urls", kind: "secret", required: true, secret: true },
    { key: "username", kind: "secret", required: false, secret: true },
    { key: "password", kind: "secret", required: false, secret: true },
  ],
  config: appriseConfigSchema,
  secrets: appriseSecretsSchema,
};
