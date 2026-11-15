import { z } from "zod";

export const CHANGE_ACTIONS = [
  "insert",
  "update",
  "delete",
  "submit",
  "lock",
  "unlock",
  "sign",
  "catalog",
  "export",
  "purge",
  "access",
] as const;

export const SIGN_IN_ACTIONS = [
  "account_created",
  "login_success",
  "login_failure",
  "logout",
  "session_revoked",
  "factors_cleared",
  "token_created",
  "install_token_issued",
  "install_token_used",
  "tokens_revoked",
  "account_locked",
  "account_unlocked",
  "password_changed",
  "password_reset_requested",
  "password_reset",
  "settings_changed",
  "account_disabled",
  "account_erased",
  "account_updated",
  "account_data_exported",
  "sso_unlinked",
  "operator_mail_sent",
] as const;

const instant = z.iso.datetime().optional().catch(undefined);
const dir = z.enum(["asc", "desc"]).optional().catch(undefined);

/**
 * The change trail's filters as the address keeps them. Newest first is
 * the default and leaves the address.
 */
export const changesSearchSchema = z.object({
  action: z.enum(CHANGE_ACTIONS).optional().catch(undefined),
  source: z.string().trim().max(100).optional().catch(undefined),
  from: instant,
  to: instant,
  dir,
});

export type ChangesSearch = z.infer<typeof changesSearchSchema>;

export function parseChangesSearch(value: unknown): ChangesSearch {
  return changesSearchSchema.parse(value);
}

export const signInSearchSchema = z.object({
  action: z.enum(SIGN_IN_ACTIONS).optional().catch(undefined),
  from: instant,
  to: instant,
  dir,
});

export type SignInSearch = z.infer<typeof signInSearchSchema>;

export function parseSignInSearch(value: unknown): SignInSearch {
  return signInSearchSchema.parse(value);
}

type Ranged = { from?: string; to?: string; dir?: "asc" | "desc" };

/** The start sits after the end: the page says so and does not ask. */
export function trailRangeInvalid(search: Ranged): boolean {
  return Boolean(search.from && search.to && search.from > search.to);
}

function kept<T extends Ranged>(merged: T, extra: Partial<T>): T {
  const next = { ...extra } as T;
  if (merged.from) next.from = merged.from;
  if (merged.to) next.to = merged.to;
  if (merged.dir === "asc") next.dir = "asc";
  return next;
}

export function nextChanges(
  current: ChangesSearch,
  patch: Partial<ChangesSearch>,
): ChangesSearch {
  const merged: ChangesSearch = { ...current, ...patch };
  return kept(merged, {
    ...(merged.action ? { action: merged.action } : {}),
    ...(merged.source ? { source: merged.source } : {}),
  });
}

export function nextSignIns(
  current: SignInSearch,
  patch: Partial<SignInSearch>,
): SignInSearch {
  const merged: SignInSearch = { ...current, ...patch };
  return kept(merged, merged.action ? { action: merged.action } : {});
}

/** The date column: newest first, then oldest first. */
export function toggleChangesDir(current: ChangesSearch): ChangesSearch {
  return nextChanges(current, {
    dir: (current.dir ?? "desc") === "desc" ? "asc" : "desc",
  });
}

export function toggleSignInDir(current: SignInSearch): SignInSearch {
  return nextSignIns(current, {
    dir: (current.dir ?? "desc") === "desc" ? "asc" : "desc",
  });
}
