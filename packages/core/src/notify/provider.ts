import type { z } from "zod";

export type NotifyFamily =
  "channel" | "heartbeat" | "metrics" | "errors" | "traces";

export type ProviderFieldKind =
  "url" | "text" | "secret" | "number" | "select" | "strings" | "headers";

/** What the administration form draws. A secret is never sent back. */
export type ProviderField = {
  key: string;
  kind: ProviderFieldKind;
  required: boolean;
  secret: boolean;
  options?: readonly string[];
};

/**
 * One tool. The form is this description; the request it makes lives in
 * the API, so the screen never learns how the tool is called.
 */
export type NotifyProvider = {
  id: string;
  family: NotifyFamily;
  label: string;
  docsUrl: string;
  subscribes: boolean;
  singleton: boolean;
  fields: readonly ProviderField[];
  config: z.ZodType;
  secrets: z.ZodType;
};
