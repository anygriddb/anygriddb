/**
 * SSO-only sign-in (ADR 0053): non-administrators open a session only
 * through the identity provider. Administrators keep a password as
 * break-glass.
 */
import { AppError, type InstanceSettings } from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { sql } from "kysely";
import { readSettings } from "../settings.js";

/** The variables that hold a provider in the instance's environment. */
export type ProviderEnvironment = {
  OIDC_ISSUER?: string;
  OIDC_CLIENT_ID?: string;
  OIDC_CLIENT_SECRET?: string;
  OIDC_REDIRECT_URL?: string;
  SAML_ENTRY_POINT?: string;
  SAML_ISSUER?: string;
  SAML_CERT?: string;
  SAML_CALLBACK_URL?: string;
};

/** Refuses password or passkey sign-in for a non-admin when SSO-only is on. */
export function assertLocalSignInAllowed(
  settings: Pick<InstanceSettings, "ssoOnly">,
  account: { isAdmin: boolean } | null | undefined,
): void {
  if (!settings.ssoOnly) return;
  if (account?.isAdmin) return;
  throw new AppError("password_sign_in_disabled");
}

/** Refuses creating an account with a password while SSO-only is on. */
export function assertPasswordSignupAllowed(
  settings: Pick<InstanceSettings, "ssoOnly">,
): void {
  if (settings.ssoOnly) throw new AppError("password_sign_in_disabled");
}

function environmentHoldsProvider(env: ProviderEnvironment): boolean {
  return (
    Boolean(
      env.OIDC_ISSUER &&
      env.OIDC_CLIENT_ID &&
      env.OIDC_CLIENT_SECRET &&
      env.OIDC_REDIRECT_URL,
    ) ||
    Boolean(
      env.SAML_ENTRY_POINT &&
      env.SAML_ISSUER &&
      env.SAML_CERT &&
      env.SAML_CALLBACK_URL,
    )
  );
}

/**
 * In the transaction that removes a saved provider: refuses to leave an
 * SSO-only instance with none. Two removals take turns, so that each sees
 * what the other left.
 */
export async function assertProviderRemains(
  tx: Database,
  env: ProviderEnvironment,
  otherTable: "instanceOidc" | "instanceSaml",
): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtext('anygriddb:sso-providers'))`.execute(
    tx,
  );
  if (!(await readSettings(tx)).ssoOnly) return;
  if (environmentHoldsProvider(env)) return;
  const other = await tx.selectFrom(otherTable).select("id").executeTakeFirst();
  if (!other) throw new AppError("sso_last_provider");
}

/**
 * Before an account stops being an active administrator: under SSO-only,
 * the last one with a password stays, the way in if the provider fails.
 * Every active administrator is locked, in one order, so that two removals
 * at once cannot each count on the other.
 */
export async function assertKeepsPasswordAdmin(
  tx: Database,
  userId: string,
): Promise<void> {
  if (!(await readSettings(tx)).ssoOnly) return;
  const admins = await tx
    .selectFrom("users as u")
    .leftJoin("passwordHashes as p", "p.userId", "u.id")
    .select(["u.id", "p.userId as passwordOf"])
    .where("u.isAdmin", "=", true)
    .where("u.disabledAt", "is", null)
    .orderBy("u.id")
    .forUpdate("u")
    .execute();
  const target = admins.find((admin) => admin.id === userId);
  if (!target?.passwordOf) return;
  if (!admins.some((admin) => admin.id !== userId && admin.passwordOf)) {
    throw new AppError("sso_last_password_admin");
  }
}
