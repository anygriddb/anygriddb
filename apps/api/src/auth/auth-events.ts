/**
 * The sign-in trail (ADRs 0042, 0043): who signed in, failed, or signed
 * out, what an administrator did to an account, and who changed which
 * setting. It never holds an email, a password, or a token: an account id
 * when one is known, a short method, a stable detail code, and the client
 * address, kept six months to a year as the instance says.
 */
import { isIP } from "node:net";
import type { InstanceSettings } from "@anygriddb/core";
import type { AuthAction, Database } from "@anygriddb/db";

export type AuthMethod =
  | "password"
  | "totp"
  | "backup"
  | "webauthn"
  | "oidc"
  | "saml"
  | "signup"
  | "admin";

export type AuthDetail =
  | "invalid_credentials"
  | "account_disabled"
  | "instance_maintenance"
  | "mfa_failed"
  | "admin_disable"
  | "admin_erase"
  /** What an administrator corrected on an account (`account_updated`). */
  | "display_name"
  | "email"
  | "admin_revoke_session"
  | "admin_revoke_user"
  | "admin_revoke_all"
  | "maintenance"
  | "account_locked"
  | "admin_unlock"
  | "self_service"
  | "admin_reset"
  | "reset_link"
  /** Disabled after the instance's delay without activity (ADR 0044). */
  | "inactive"
  /** A setting that changed (`settings_changed`): its key. */
  | keyof InstanceSettings
  /** An integration saved or cleared from Administration (ADR 0050). */
  | "smtp"
  | "oidc"
  | "saml"
  /** Operator mail recipients (ADR 0052): all active, or a chosen list. */
  | "all_active"
  | "selected";

/** Only an address is kept: anything else a proxy sent is dropped. */
export function clientAddress(raw: string | null | undefined): string | null {
  return raw && isIP(raw) !== 0 ? raw : null;
}

export type AuthEvent = {
  action: AuthAction;
  /** The account concerned, when known. */
  userId?: string | null;
  /** The administrator who acted on it. */
  actorId?: string | null;
  method?: AuthMethod | null;
  detail?: AuthDetail | null;
  ip?: string | null;
};

export async function recordAuthEvent(
  db: Database,
  event: AuthEvent,
): Promise<void> {
  await db
    .insertInto("authEvents")
    .values({
      action: event.action,
      userId: event.userId ?? null,
      actorId: event.actorId ?? null,
      method: event.method ?? null,
      detail: event.detail ?? null,
      ip: clientAddress(event.ip),
    })
    .execute();
}

/**
 * Deletes events older than the instance keeps them; the table's trigger
 * refuses to delete one younger than six months.
 */
export async function purgeAuthEvents(
  db: Database,
  retentionDays: InstanceSettings["authRetentionDays"],
): Promise<number> {
  const cutoff = new Date(Date.now() - (retentionDays + 1) * 86_400_000);
  const deleted = await db
    .deleteFrom("authEvents")
    .where("occurredAt", "<", cutoff)
    .returning("id")
    .execute();
  return deleted.length;
}
