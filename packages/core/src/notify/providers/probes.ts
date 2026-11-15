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

/** A Sentry-compatible DSN: `https://publicKey@host/project`. */
export const sentryDsnSchema = z
  .string()
  .trim()
  .max(500)
  .refine((value) => {
    try {
      const url = new URL(value);
      const project = url.pathname.replace(/^\//, "");
      return (
        url.protocol === "https:" &&
        url.username.length > 0 &&
        project.length > 0 &&
        !url.password
      );
    } catch {
      return false;
    }
  });

export const sentrySecretsSchema = z.object({ dsn: sentryDsnSchema }).strict();

export const otlpConfigSchema = z.object({ endpoint: httpsUrl }).strict();
export const otlpSecretsSchema = z
  .object({
    headers: z.string().trim().max(2_000).optional(),
  })
  .strict();

export const metricsSecretsSchema = z
  .object({ token: z.string().min(32).max(200) })
  .strict();

export const sentryProvider: NotifyProvider = {
  id: "sentry",
  family: "errors",
  label: "Errors",
  docsUrl: "https://develop.sentry.dev/sdk/data-model/envelopes/",
  subscribes: false,
  singleton: true,
  fields: [{ key: "dsn", kind: "secret", required: true, secret: true }],
  config: z.object({}).strict(),
  secrets: sentrySecretsSchema,
};

export const otlpProvider: NotifyProvider = {
  id: "otlp",
  family: "traces",
  label: "Traces",
  docsUrl: "https://opentelemetry.io/docs/specs/otlp/",
  subscribes: false,
  singleton: true,
  fields: [
    { key: "endpoint", kind: "url", required: true, secret: false },
    { key: "headers", kind: "secret", required: false, secret: true },
  ],
  config: otlpConfigSchema,
  secrets: otlpSecretsSchema,
};

export const metricsProvider: NotifyProvider = {
  id: "metrics",
  family: "metrics",
  label: "Metrics",
  docsUrl: "https://prometheus.io/docs/instrumenting/exposition_formats/",
  subscribes: false,
  singleton: true,
  fields: [{ key: "token", kind: "secret", required: true, secret: true }],
  config: z.object({}).strict(),
  secrets: metricsSecretsSchema,
};
