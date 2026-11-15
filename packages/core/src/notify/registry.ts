import { AppError } from "../errors";
import type { NotifyProvider } from "./provider";
import {
  genericBeatProvider,
  healthchecksProvider,
  uptimeKumaProvider,
} from "./providers/heartbeat";
import { appriseProvider } from "./providers/apprise";
import { gotifyProvider } from "./providers/gotify";
import { ntfyProvider } from "./providers/ntfy";
import {
  alertmanagerProvider,
  matrixProvider,
  mattermostProvider,
  rocketchatProvider,
  zulipProvider,
} from "./providers/rooms";
import {
  metricsProvider,
  otlpProvider,
  sentryProvider,
} from "./providers/probes";
import { smtpChannelProvider } from "./providers/smtp";
import { webhookProvider } from "./providers/webhook";

/** Every tool the screen can offer. Adding one is a line here. */
export const NOTIFY_PROVIDERS: readonly NotifyProvider[] = [
  webhookProvider,
  ntfyProvider,
  gotifyProvider,
  appriseProvider,
  smtpChannelProvider,
  healthchecksProvider,
  uptimeKumaProvider,
  genericBeatProvider,
  matrixProvider,
  mattermostProvider,
  rocketchatProvider,
  zulipProvider,
  alertmanagerProvider,
  metricsProvider,
  sentryProvider,
  otlpProvider,
];

export function notifyProvider(id: string): NotifyProvider | undefined {
  return NOTIFY_PROVIDERS.find((provider) => provider.id === id);
}

/** The public description, without the schemas the screen does not run. */
export function notifyProviderView(provider: NotifyProvider) {
  return {
    id: provider.id,
    family: provider.family,
    label: provider.label,
    docsUrl: provider.docsUrl,
    subscribes: provider.subscribes,
    singleton: provider.singleton,
    fields: provider.fields,
  };
}

export function parseProviderConfig(
  id: string,
  config: unknown,
  secrets: unknown,
): { config: unknown; secrets: unknown } {
  const provider = notifyProvider(id);
  if (!provider) throw new AppError("invalid_integration");
  const parsedConfig = provider.config.safeParse(config);
  const parsedSecrets = provider.secrets.safeParse(secrets);
  if (!parsedConfig.success || !parsedSecrets.success) {
    throw new AppError("invalid_integration");
  }
  return { config: parsedConfig.data, secrets: parsedSecrets.data };
}
