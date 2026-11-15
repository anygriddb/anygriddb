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

export const gotifyConfigSchema = z.object({ url: httpsUrl }).strict();
export const gotifySecretsSchema = z
  .object({ token: z.string().min(1).max(200) })
  .strict();

export const gotifyProvider: NotifyProvider = {
  id: "gotify",
  family: "channel",
  label: "Gotify",
  docsUrl: "https://gotify.net/docs/pushmsg",
  subscribes: true,
  singleton: false,
  fields: [
    { key: "url", kind: "url", required: true, secret: false },
    { key: "token", kind: "secret", required: true, secret: true },
  ],
  config: gotifyConfigSchema,
  secrets: gotifySecretsSchema,
};
