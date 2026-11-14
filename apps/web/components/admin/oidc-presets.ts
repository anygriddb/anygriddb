/**
 * The issuers two common providers document (ROADMAP row 102): the
 * address to fill and nothing else. The operator still registers an
 * application with the provider and types its client ID and secret.
 */

/** What stands for a directory's ID in Microsoft's issuer, to be replaced. */
export const TENANT_PLACEHOLDER = "TENANT-ID";

export const OIDC_PRESETS = [
  { id: "google", name: "Google", issuer: "https://accounts.google.com" },
  // Microsoft publishes one issuer per directory. Its shared addresses
  // (`common`, `organizations`) answer discovery but name no issuer a
  // sign-in can check, so every sign-in through them is refused.
  {
    id: "microsoft",
    name: "Microsoft",
    issuer: `https://login.microsoftonline.com/${TENANT_PLACEHOLDER}/v2.0`,
  },
] as const;

/** Whether an issuer still holds a preset's placeholder. */
export function needsTenant(issuer: string): boolean {
  return issuer.includes(TENANT_PLACEHOLDER);
}
